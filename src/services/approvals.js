// Generic approval engine: sequential / parallel (ALL) / pooled (ANY) / conditional / amount- and branch-based workflows.
const prisma = require('../database/prisma');
const { D } = require('../utils/money');
const { badRequest, forbidden, notFound, conflict } = require('../utils/errors');
const audit = require('./audit');
const { notify, userForEmployee } = require('./notifications');

const handlers = new Map();
/** registerHandler(entityType, { onApproved(tx, instance, ctx), onRejected(tx, instance, ctx), onStep(tx, instance, step) }) */
const registerHandler = (entityType, handler) => handlers.set(entityType, handler);

const matchesConditions = (cond, input) => {
  if (!cond) return true;
  const amount = input.amount != null ? D(input.amount) : null;
  if (cond.minAmount != null && (amount === null || amount.lessThan(D(cond.minAmount)))) return false;
  if (cond.maxAmount != null && (amount === null || amount.greaterThan(D(cond.maxAmount)))) return false;
  if (Array.isArray(cond.branchIds) && cond.branchIds.length && !cond.branchIds.includes(input.branchId)) return false;
  if (Array.isArray(cond.leaveTypeIds) && cond.leaveTypeIds.length && !cond.leaveTypeIds.includes(input.leaveTypeId)) return false;
  return true;
};

const selectWorkflow = async (tx, companyId, entityType, input) => {
  const flows = await tx.approvalWorkflow.findMany({
    where: { companyId, entityType, status: 'ACTIVE' },
    include: { steps: { orderBy: { stepOrder: 'asc' } } },
    orderBy: [{ priority: 'desc' }, { isDefault: 'asc' }],
  });
  if (input.workflowId) {
    const explicit = flows.find((f) => f.id === input.workflowId);
    if (explicit) return explicit;
  }
  return flows.find((f) => !f.isDefault && matchesConditions(f.conditions, input)) || flows.find((f) => f.isDefault) || null;
};

const resolveApprovers = async (tx, companyId, step, requester) => {
  switch (step.approverType) {
    case 'DIRECT_MANAGER':
      return [await userForEmployee(requester?.managerId, tx)];
    case 'DEPARTMENT_MANAGER': {
      if (!requester?.departmentId) return [];
      const dep = await tx.department.findFirst({ where: { id: requester.departmentId, companyId }, select: { managerId: true } });
      return [await userForEmployee(dep?.managerId, tx)];
    }
    case 'BRANCH_MANAGER': {
      if (!requester?.branchId) return [];
      const br = await tx.branch.findFirst({ where: { id: requester.branchId, companyId }, select: { managerId: true } });
      return [await userForEmployee(br?.managerId, tx)];
    }
    case 'ROLE': {
      const rows = await tx.userRole.findMany({
        where: { role: { companyId, code: step.roleCode }, user: { status: 'ACTIVE', deletedAt: null } },
        include: { role: { select: { dataScope: true } }, user: { select: { id: true, employee: { select: { branchId: true } } } } },
      });
      // Branch-based approval: branch-scoped roles only approve requests of their own branch
      return rows
        .filter((r) => r.role.dataScope !== 'BRANCH' || !requester?.branchId || r.branchId === requester.branchId || r.user.employee?.branchId === requester.branchId)
        .map((r) => r.userId);
    }
    case 'USER':
      return [step.userId];
    default:
      return [];
  }
};

/**
 * start(tx, ctx, { entityType, entityId, requesterEmployeeId, amount, branchId, leaveTypeId, summary, workflowId })
 * Returns { instance, completed: boolean, pendingStatus }
 */
const start = async (tx, ctx, input) => {
  const requester = input.requesterEmployeeId
    ? await tx.employee.findFirst({ where: { id: input.requesterEmployeeId, companyId: ctx.companyId }, select: { id: true, managerId: true, departmentId: true, branchId: true } })
    : null;
  const flow = await selectWorkflow(tx, ctx.companyId, input.entityType, { ...input, branchId: input.branchId ?? requester?.branchId });
  if (!flow) throw badRequest('NO_WORKFLOW_CONFIGURED', { entityType: input.entityType });
  if (!flow.steps.length) throw badRequest('WORKFLOW_HAS_NO_STEPS');

  const requesterUserId = input.requesterUserId ?? (await userForEmployee(input.requesterEmployeeId, tx));
  const instance = await tx.approvalInstance.create({
    data: {
      companyId: ctx.companyId, workflowId: flow.id, entityType: input.entityType, entityId: input.entityId,
      requesterUserId, requesterEmployeeId: input.requesterEmployeeId || null,
      amount: input.amount != null ? String(input.amount) : null, summary: input.summary?.slice(0, 300) || null,
    },
  });

  for (const step of flow.steps) {
    const applicable = matchesConditions(step.condition, input);
    let approvers = applicable ? (await resolveApprovers(tx, ctx.companyId, step, requester)).filter(Boolean) : [];
    // Nobody approves their own request (segregation of duties)
    approvers = [...new Set(approvers)].filter((u) => u !== requesterUserId && u !== ctx.userId);
    if (!approvers.length) {
      await tx.approvalTask.create({
        data: { instanceId: instance.id, stepOrder: step.stepOrder, stepName: step.name, mode: step.mode, status: 'SKIPPED', comment: applicable ? 'NO_APPROVER' : 'CONDITION_NOT_MET', actedAt: new Date() },
      });
      continue;
    }
    await tx.approvalTask.createMany({
      data: approvers.map((u) => ({ instanceId: instance.id, stepOrder: step.stepOrder, stepName: step.name, mode: step.mode, approverUserId: u, status: 'WAITING' })),
    });
  }

  return advance(tx, ctx, instance.id, flow);
};

// Moves the instance to its next step with WAITING tasks, or completes it.
const advance = async (tx, ctx, instanceId, flowArg) => {
  const instance = await tx.approvalInstance.findUnique({ where: { id: instanceId }, include: { tasks: true } });
  const flow = flowArg || (await tx.approvalWorkflow.findUnique({ where: { id: instance.workflowId }, include: { steps: true } }));
  const waitingOrders = [...new Set(instance.tasks.filter((t) => t.status === 'WAITING').map((t) => t.stepOrder))].sort((a, b) => a - b);
  const handler = handlers.get(instance.entityType);

  if (!waitingOrders.length) {
    const done = await tx.approvalInstance.update({ where: { id: instanceId }, data: { status: 'APPROVED', completedAt: new Date() } });
    if (handler?.onApproved) await handler.onApproved(tx, done, ctx);
    if (instance.requesterUserId) {
      await notify({ companyId: instance.companyId, userIds: [instance.requesterUserId], type: 'REQUEST_APPROVED', params: { entityType: instance.entityType, summary: instance.summary }, link: linkFor(instance) }, tx);
    }
    return { instance: done, completed: true, pendingStatus: null };
  }

  const next = waitingOrders[0];
  await tx.approvalTask.updateMany({ where: { instanceId, stepOrder: next, status: 'WAITING' }, data: { status: 'PENDING' } });
  const updated = await tx.approvalInstance.update({ where: { id: instanceId }, data: { currentStep: next } });
  const step = flow.steps.find((s) => s.stepOrder === next);
  const pendingStatus = step?.pendingStatus || 'PENDING_APPROVAL';
  if (handler?.onStep) await handler.onStep(tx, updated, pendingStatus);
  const approvers = instance.tasks.filter((t) => t.stepOrder === next).map((t) => t.approverUserId);
  await notify({ companyId: instance.companyId, userIds: approvers, type: 'APPROVAL_REQUIRED', params: { entityType: instance.entityType, summary: instance.summary, step: step?.name }, link: '/approvals' }, tx);
  return { instance: updated, completed: false, pendingStatus };
};

const linkFor = (instance) => {
  const map = { LEAVE: '/leaves', LEAVE_CANCELLATION: '/leaves', ATTENDANCE_CORRECTION: '/attendance/corrections', SHIFT_EXCHANGE: '/shifts/exchanges', ADVANCE: `/advances/${instance.entityId}`, LOAN: `/loans/${instance.entityId}`, PAYROLL: `/payroll/runs/${instance.entityId}`, SALARY_CHANGE: '/employees' };
  return map[instance.entityType] || '/approvals';
};

/** act(ctx, taskId, 'APPROVE'|'REJECT', comment) */
const act = async (ctx, taskId, decision, comment) => {
  return prisma.$transaction(async (tx) => {
    const task = await tx.approvalTask.findUnique({ where: { id: taskId }, include: { instance: true } });
    if (!task || task.instance.companyId !== ctx.companyId) throw notFound('APPROVAL_TASK_NOT_FOUND');
    if (task.approverUserId !== ctx.userId) throw forbidden('NOT_YOUR_APPROVAL');
    if (task.status !== 'PENDING' || task.instance.status !== 'PENDING') throw conflict('APPROVAL_ALREADY_DECIDED');
    if (decision === 'REJECT' && !comment) throw badRequest('REJECTION_REASON_REQUIRED');

    // Row lock on the instance to serialize concurrent decisions
    await tx.$queryRaw`SELECT id FROM approval_instances WHERE id = ${task.instanceId} FOR UPDATE`;

    await tx.approvalTask.update({ where: { id: taskId }, data: { status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', comment: comment || null, actedAt: new Date() } });
    await audit.record(ctx, { action: `APPROVAL_${decision}`, entityType: task.instance.entityType, entityId: task.instance.entityId, employeeId: task.instance.requesterEmployeeId, newValue: { step: task.stepName, comment } }, tx);

    const handler = handlers.get(task.instance.entityType);
    if (decision === 'REJECT') {
      await tx.approvalTask.updateMany({ where: { instanceId: task.instanceId, status: { in: ['PENDING', 'WAITING'] } }, data: { status: 'CLOSED' } });
      const inst = await tx.approvalInstance.update({ where: { id: task.instanceId }, data: { status: 'REJECTED', completedAt: new Date() } });
      if (handler?.onRejected) await handler.onRejected(tx, inst, ctx, comment);
      if (inst.requesterUserId) {
        await notify({ companyId: inst.companyId, userIds: [inst.requesterUserId], type: 'REQUEST_REJECTED', params: { entityType: inst.entityType, summary: inst.summary, comment }, link: linkFor(inst) }, tx);
      }
      return { status: 'REJECTED' };
    }

    if (task.mode === 'ANY') {
      await tx.approvalTask.updateMany({ where: { instanceId: task.instanceId, stepOrder: task.stepOrder, status: 'PENDING' }, data: { status: 'CLOSED' } });
    } else {
      const remaining = await tx.approvalTask.count({ where: { instanceId: task.instanceId, stepOrder: task.stepOrder, status: 'PENDING' } });
      if (remaining > 0) return { status: 'PENDING' };
    }
    const res = await advance(tx, ctx, task.instanceId);
    return { status: res.completed ? 'APPROVED' : 'PENDING' };
  });
};

const cancel = async (tx, instanceId, reason = 'CANCELLED') => {
  if (!instanceId) return;
  await tx.approvalTask.updateMany({ where: { instanceId, status: { in: ['PENDING', 'WAITING'] } }, data: { status: 'CLOSED', comment: reason } });
  await tx.approvalInstance.updateMany({ where: { id: instanceId, status: 'PENDING' }, data: { status: 'CANCELLED', completedAt: new Date() } });
};

const timeline = async (companyId, entityType, entityId) => {
  const instances = await prisma.approvalInstance.findMany({
    where: { companyId, entityType, entityId },
    include: { tasks: { orderBy: [{ stepOrder: 'asc' }, { createdAt: 'asc' }] }, workflow: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const userIds = [...new Set(instances.flatMap((i) => i.tasks.map((t) => t.approverUserId)).filter(Boolean))];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } });
  const nameOf = new Map(users.map((u) => [u.id, u.displayName]));
  return instances.map((i) => ({ ...i, tasks: i.tasks.map((t) => ({ ...t, approverName: nameOf.get(t.approverUserId) || null })) }));
};

module.exports = { registerHandler, start, act, cancel, timeline, matchesConditions, selectWorkflow };
