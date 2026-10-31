const { z, str, optStr, optId, optDate, date, money, nonNegativeMoney } = require('../../utils/validate');

const STATUSES = ['ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'PROBATION', 'RESIGNED', 'TERMINATED', 'INACTIVE'];
const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'TEMPORARY', 'INTERN'];
const CONTRACT_TYPES = ['LIMITED', 'UNLIMITED', 'PROJECT', 'SEASONAL'];
const DOC_TYPES = ['NATIONAL_ID', 'IQAMA', 'PASSPORT', 'CONTRACT', 'CERTIFICATE', 'LICENSE', 'TRAINING', 'MEDICAL_INSURANCE', 'OTHER'];

// IBAN: ISO 13616 mod-97 check
const ibanValid = (raw) => {
  const iban = String(raw).replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
};
const iban = z.string().trim().transform((v) => v.replace(/\s+/g, '').toUpperCase()).refine((v) => v === '' || ibanValid(v), 'Invalid IBAN').nullable().optional().transform((v) => v || null);
const phone = z.string().trim().max(30).regex(/^[+\d\s()-]*$/, 'Invalid phone').nullable().optional().transform((v) => v || null);

const personal = {
  firstName: str(100), middleName: optStr(100), lastName: str(100), fullNameAr: optStr(250), fullNameEn: optStr(250),
  gender: z.enum(['MALE', 'FEMALE']).nullable().optional(), dateOfBirth: optDate, nationality: optStr(60),
  maritalStatus: z.enum(['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED']).nullable().optional(),
  nationalId: optStr(40), passportNumber: optStr(40), passportExpiry: optDate,
  mobile: phone, altMobile: phone, email: z.string().trim().email().max(191).nullable().optional().or(z.literal('').transform(() => null)),
  country: optStr(60), city: optStr(100), address: optStr(500),
};

const employment = {
  employeeNumber: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_\-/]+$/, 'Invalid employee number').optional(),
  branchId: optId, departmentId: optId, sectionId: optId, teamId: optId, positionId: optId, gradeId: optId, managerId: optId,
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(), contractType: z.enum(CONTRACT_TYPES).optional(), workLocation: optStr(200),
  hireDate: date, probationStart: optDate, probationEnd: optDate, contractStart: optDate, contractEnd: optDate,
  noticePeriodDays: z.coerce.number().int().min(0).max(365).nullable().optional(), defaultShiftId: optId, attendancePolicyId: optId,
  salaryStructureId: optId, jobLevel: optStr(40), status: z.enum(STATUSES).optional(),
};

const financial = {
  paymentFrequency: z.enum(['MONTHLY', 'WEEKLY', 'BIWEEKLY']).optional(), paymentMethod: z.enum(['BANK', 'CASH', 'CHEQUE']).optional(),
  bankName: optStr(120), iban, accountHolder: optStr(200), gosiApplicable: z.boolean().optional(), gosiNumber: optStr(40),
};

const salaryLines = z.array(z.object({ componentId: z.string().uuid(), amount: nonNegativeMoney })).max(50);

const dateOrder = (v) => (!v.probationStart || !v.probationEnd || v.probationStart <= v.probationEnd) && (!v.contractStart || !v.contractEnd || v.contractStart <= v.contractEnd);

const createSchema = z.object({
  ...personal, ...employment, ...financial,
  emergencyContact: z.object({ name: str(200), relationship: str(60), phone: str(30) }).nullable().optional(),
  salary: z.object({ effectiveFrom: date.optional(), lines: salaryLines }).optional(),
}).refine(dateOrder, { message: 'End date must be after start date', path: ['contractEnd'] });

const updateSchema = z.object({
  ...personal, ...employment, ...financial, hireDate: date.optional(), firstName: str(100).optional(), lastName: str(100).optional(),
  reason: optStr(500),
}).partial().refine(dateOrder, { message: 'End date must be after start date', path: ['contractEnd'] });

const salaryRevisionSchema = z.object({ effectiveFrom: date, reason: str(500), lines: salaryLines.min(1) });

const transferSchema = z.object({
  branchId: optId, departmentId: optId, sectionId: optId, teamId: optId, positionId: optId, managerId: optId,
  effectiveDate: date, reason: str(500),
});

const statusActionSchema = z.object({ effectiveDate: date, reason: str(500) });

const documentSchema = z.object({
  type: z.enum(DOC_TYPES), name: str(200), number: optStr(80), issueDate: optDate, expiryDate: optDate,
  alertDaysBefore: z.coerce.number().int().min(0).max(365).nullable().optional(), notes: optStr(1000),
});

module.exports = { createSchema, updateSchema, salaryRevisionSchema, transferSchema, statusActionSchema, documentSchema, STATUSES, EMPLOYMENT_TYPES, CONTRACT_TYPES, DOC_TYPES, ibanValid, money };
