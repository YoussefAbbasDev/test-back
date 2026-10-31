-- CreateTable
CREATE TABLE `companies` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `nameAr` VARCHAR(200) NOT NULL,
    `nameEn` VARCHAR(200) NOT NULL,
    `logoFileId` CHAR(36) NULL,
    `defaultLanguage` VARCHAR(5) NOT NULL DEFAULT 'ar',
    `currency` VARCHAR(3) NOT NULL DEFAULT 'SAR',
    `timezone` VARCHAR(64) NOT NULL DEFAULT 'Asia/Riyadh',
    `country` VARCHAR(2) NOT NULL DEFAULT 'SA',
    `weekendDays` JSON NOT NULL,
    `workWeekStartsOn` INTEGER NOT NULL DEFAULT 0,
    `documentAlertDays` INTEGER NOT NULL DEFAULT 30,
    `contractAlertDays` INTEGER NOT NULL DEFAULT 60,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `companies_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `branches` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `nameAr` VARCHAR(200) NOT NULL,
    `nameEn` VARCHAR(200) NOT NULL,
    `city` VARCHAR(100) NULL,
    `address` VARCHAR(500) NULL,
    `phone` VARCHAR(30) NULL,
    `latitude` DECIMAL(10, 7) NULL,
    `longitude` DECIMAL(10, 7) NULL,
    `managerId` CHAR(36) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `branches_companyId_status_idx`(`companyId`, `status`),
    UNIQUE INDEX `branches_companyId_code_key`(`companyId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `users` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NULL,
    `employeeId` CHAR(36) NULL,
    `email` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(100) NOT NULL,
    `displayName` VARCHAR(200) NOT NULL,
    `language` VARCHAR(5) NOT NULL DEFAULT 'ar',
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `isSuperAdmin` BOOLEAN NOT NULL DEFAULT false,
    `failedLogins` INTEGER NOT NULL DEFAULT 0,
    `lockedUntil` DATETIME(3) NULL,
    `lastLoginAt` DATETIME(3) NULL,
    `passwordChangedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `users_employeeId_key`(`employeeId`),
    UNIQUE INDEX `users_email_key`(`email`),
    INDEX `users_companyId_idx`(`companyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refresh_tokens` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `family` CHAR(36) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `replacedBy` CHAR(36) NULL,
    `ip` VARCHAR(64) NULL,
    `userAgent` VARCHAR(300) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `refresh_tokens_tokenHash_key`(`tokenHash`),
    INDEX `refresh_tokens_userId_idx`(`userId`),
    INDEX `refresh_tokens_family_idx`(`family`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `roles` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NULL,
    `code` VARCHAR(60) NOT NULL,
    `nameAr` VARCHAR(120) NOT NULL,
    `nameEn` VARCHAR(120) NOT NULL,
    `description` VARCHAR(500) NULL,
    `isSystem` BOOLEAN NOT NULL DEFAULT false,
    `dataScope` VARCHAR(20) NOT NULL DEFAULT 'OWN',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `roles_companyId_code_key`(`companyId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `permissions` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(100) NOT NULL,
    `module` VARCHAR(50) NOT NULL,
    `action` VARCHAR(30) NOT NULL,

    UNIQUE INDEX `permissions_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `role_permissions` (
    `roleId` CHAR(36) NOT NULL,
    `permissionId` CHAR(36) NOT NULL,

    PRIMARY KEY (`roleId`, `permissionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_roles` (
    `userId` CHAR(36) NOT NULL,
    `roleId` CHAR(36) NOT NULL,
    `branchId` CHAR(36) NULL,

    PRIMARY KEY (`userId`, `roleId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `departments` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `branchId` CHAR(36) NULL,
    `parentId` CHAR(36) NULL,
    `type` VARCHAR(20) NOT NULL DEFAULT 'DEPARTMENT',
    `code` VARCHAR(40) NOT NULL,
    `nameAr` VARCHAR(200) NOT NULL,
    `nameEn` VARCHAR(200) NOT NULL,
    `description` TEXT NULL,
    `managerId` CHAR(36) NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `departments_companyId_parentId_idx`(`companyId`, `parentId`),
    UNIQUE INDEX `departments_companyId_code_key`(`companyId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `teams` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `departmentId` CHAR(36) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `nameAr` VARCHAR(200) NOT NULL,
    `nameEn` VARCHAR(200) NOT NULL,
    `leaderId` CHAR(36) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `teams_companyId_code_key`(`companyId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_grades` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `level` INTEGER NOT NULL DEFAULT 1,
    `minSalary` DECIMAL(14, 2) NULL,
    `maxSalary` DECIMAL(14, 2) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `job_grades_companyId_code_key`(`companyId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_positions` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `departmentId` CHAR(36) NULL,
    `gradeId` CHAR(36) NULL,
    `reportsToPositionId` CHAR(36) NULL,
    `code` VARCHAR(40) NOT NULL,
    `titleAr` VARCHAR(200) NOT NULL,
    `titleEn` VARCHAR(200) NOT NULL,
    `level` INTEGER NULL,
    `description` TEXT NULL,
    `requiredSkills` TEXT NULL,
    `salaryMin` DECIMAL(14, 2) NULL,
    `salaryMax` DECIMAL(14, 2) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `job_positions_companyId_code_key`(`companyId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employees` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `employeeNumber` VARCHAR(40) NOT NULL,
    `firstName` VARCHAR(100) NOT NULL,
    `middleName` VARCHAR(100) NULL,
    `lastName` VARCHAR(100) NOT NULL,
    `fullNameAr` VARCHAR(250) NULL,
    `fullNameEn` VARCHAR(250) NULL,
    `photoFileId` CHAR(36) NULL,
    `gender` VARCHAR(10) NULL,
    `dateOfBirth` DATE NULL,
    `nationality` VARCHAR(60) NULL,
    `maritalStatus` VARCHAR(20) NULL,
    `nationalId` VARCHAR(40) NULL,
    `passportNumber` VARCHAR(40) NULL,
    `passportExpiry` DATE NULL,
    `mobile` VARCHAR(30) NULL,
    `altMobile` VARCHAR(30) NULL,
    `email` VARCHAR(191) NULL,
    `country` VARCHAR(60) NULL,
    `city` VARCHAR(100) NULL,
    `address` VARCHAR(500) NULL,
    `branchId` CHAR(36) NULL,
    `departmentId` CHAR(36) NULL,
    `sectionId` CHAR(36) NULL,
    `teamId` CHAR(36) NULL,
    `positionId` CHAR(36) NULL,
    `gradeId` CHAR(36) NULL,
    `managerId` CHAR(36) NULL,
    `employmentType` VARCHAR(20) NOT NULL DEFAULT 'FULL_TIME',
    `contractType` VARCHAR(20) NOT NULL DEFAULT 'LIMITED',
    `workLocation` VARCHAR(200) NULL,
    `hireDate` DATE NOT NULL,
    `probationStart` DATE NULL,
    `probationEnd` DATE NULL,
    `contractStart` DATE NULL,
    `contractEnd` DATE NULL,
    `noticePeriodDays` INTEGER NULL,
    `defaultShiftId` CHAR(36) NULL,
    `attendancePolicyId` CHAR(36) NULL,
    `salaryStructureId` CHAR(36) NULL,
    `jobLevel` VARCHAR(40) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `terminationDate` DATE NULL,
    `paymentFrequency` VARCHAR(20) NOT NULL DEFAULT 'MONTHLY',
    `paymentMethod` VARCHAR(20) NOT NULL DEFAULT 'BANK',
    `bankName` VARCHAR(120) NULL,
    `iban` VARCHAR(34) NULL,
    `accountHolder` VARCHAR(200) NULL,
    `gosiApplicable` BOOLEAN NOT NULL DEFAULT false,
    `gosiNumber` VARCHAR(40) NULL,
    `kioskPinHash` VARCHAR(100) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `archivedAt` DATETIME(3) NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `employees_companyId_status_idx`(`companyId`, `status`),
    INDEX `employees_companyId_branchId_idx`(`companyId`, `branchId`),
    INDEX `employees_companyId_departmentId_idx`(`companyId`, `departmentId`),
    INDEX `employees_companyId_managerId_idx`(`companyId`, `managerId`),
    INDEX `employees_companyId_nationalId_idx`(`companyId`, `nationalId`),
    INDEX `employees_companyId_mobile_idx`(`companyId`, `mobile`),
    UNIQUE INDEX `employees_companyId_employeeNumber_key`(`companyId`, `employeeNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_emergency_contacts` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `employeeId` CHAR(36) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `relationship` VARCHAR(60) NOT NULL,
    `phone` VARCHAR(30) NOT NULL,
    `isPrimary` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `employee_emergency_contacts_employeeId_idx`(`employeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_employment_history` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `employeeId` CHAR(36) NOT NULL,
    `changeType` VARCHAR(40) NOT NULL,
    `field` VARCHAR(60) NOT NULL,
    `oldValue` VARCHAR(250) NULL,
    `newValue` VARCHAR(250) NULL,
    `oldLabel` VARCHAR(250) NULL,
    `newLabel` VARCHAR(250) NULL,
    `effectiveDate` DATE NOT NULL,
    `reason` VARCHAR(500) NULL,
    `changedById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `employee_employment_history_companyId_employeeId_effectiveDa_idx`(`companyId`, `employeeId`, `effectiveDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_salary_revisions` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `employeeId` CHAR(36) NOT NULL,
    `effectiveFrom` DATE NOT NULL,
    `reason` VARCHAR(500) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `employee_salary_revisions_companyId_employeeId_idx`(`companyId`, `employeeId`),
    UNIQUE INDEX `employee_salary_revisions_employeeId_effectiveFrom_key`(`employeeId`, `effectiveFrom`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_salary_components` (
    `id` CHAR(36) NOT NULL,
    `revisionId` CHAR(36) NOT NULL,
    `componentId` CHAR(36) NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,

    UNIQUE INDEX `employee_salary_components_revisionId_componentId_key`(`revisionId`, `componentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_documents` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `employeeId` CHAR(36) NOT NULL,
    `type` VARCHAR(30) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `number` VARCHAR(80) NULL,
    `issueDate` DATE NULL,
    `expiryDate` DATE NULL,
    `alertDaysBefore` INTEGER NULL,
    `fileId` CHAR(36) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'VALID',
    `notes` VARCHAR(1000) NULL,
    `lastAlertAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `employee_documents_companyId_expiryDate_idx`(`companyId`, `expiryDate`),
    INDEX `employee_documents_employeeId_idx`(`employeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `file_attachments` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `storageKey` VARCHAR(300) NOT NULL,
    `originalName` VARCHAR(300) NOT NULL,
    `mimeType` VARCHAR(120) NOT NULL,
    `size` INTEGER NOT NULL,
    `entityType` VARCHAR(60) NULL,
    `entityId` CHAR(36) NULL,
    `uploadedById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `file_attachments_storageKey_key`(`storageKey`),
    INDEX `file_attachments_companyId_entityType_entityId_idx`(`companyId`, `entityType`, `entityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_policies` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `scope` VARCHAR(20) NOT NULL DEFAULT 'COMPANY',
    `branchId` CHAR(36) NULL,
    `departmentId` CHAR(36) NULL,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `graceMinutes` INTEGER NOT NULL DEFAULT 10,
    `lateCountFromShiftStart` BOOLEAN NOT NULL DEFAULT true,
    `halfDayThresholdMinutes` INTEGER NULL,
    `earlyLeaveGraceMinutes` INTEGER NOT NULL DEFAULT 5,
    `minWorkingMinutes` INTEGER NULL,
    `breakMinutes` INTEGER NOT NULL DEFAULT 60,
    `overtimeEnabled` BOOLEAN NOT NULL DEFAULT true,
    `overtimeMinMinutes` INTEGER NOT NULL DEFAULT 30,
    `overtimeRequiresApproval` BOOLEAN NOT NULL DEFAULT true,
    `weekendWorkIsOvertime` BOOLEAN NOT NULL DEFAULT true,
    `holidayWorkIsOvertime` BOOLEAN NOT NULL DEFAULT true,
    `missingCheckoutAction` VARCHAR(30) NOT NULL DEFAULT 'MARK_INCOMPLETE',
    `allowMultipleSessions` BOOLEAN NOT NULL DEFAULT true,
    `correctionWindowDays` INTEGER NOT NULL DEFAULT 7,
    `correctionRequiresHR` BOOLEAN NOT NULL DEFAULT false,
    `requireGeofence` BOOLEAN NOT NULL DEFAULT true,
    `maxGpsAccuracyMeters` INTEGER NOT NULL DEFAULT 100,
    `rejectOutsideGeofence` BOOLEAN NOT NULL DEFAULT true,
    `allowedMethods` JSON NOT NULL,
    `minMinutesBetweenEvents` INTEGER NOT NULL DEFAULT 1,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `attendance_policies_companyId_scope_idx`(`companyId`, `scope`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_locations` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `branchId` CHAR(36) NULL,
    `name` VARCHAR(150) NOT NULL,
    `type` VARCHAR(20) NOT NULL DEFAULT 'BRANCH',
    `latitude` DECIMAL(10, 7) NOT NULL,
    `longitude` DECIMAL(10, 7) NOT NULL,
    `radiusMeters` INTEGER NOT NULL DEFAULT 150,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `attendance_locations_companyId_branchId_idx`(`companyId`, `branchId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_devices` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `branchId` CHAR(36) NULL,
    `type` VARCHAR(20) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `serial` VARCHAR(120) NULL,
    `apiKeyHash` CHAR(64) NULL,
    `apiKeyPrefix` VARCHAR(12) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `lastSeenAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `attendance_devices_companyId_idx`(`companyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_qr_tokens` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `branchId` CHAR(36) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `attendance_qr_tokens_tokenHash_key`(`tokenHash`),
    INDEX `attendance_qr_tokens_companyId_branchId_expiresAt_idx`(`companyId`, `branchId`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_records` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `employeeId` CHAR(36) NOT NULL,
    `date` DATE NOT NULL,
    `shiftId` CHAR(36) NULL,
    `scheduledStart` DATETIME(3) NULL,
    `scheduledEnd` DATETIME(3) NULL,
    `firstCheckIn` DATETIME(3) NULL,
    `lastCheckOut` DATETIME(3) NULL,
    `checkInMethod` VARCHAR(20) NULL,
    `checkOutMethod` VARCHAR(20) NULL,
    `checkInLat` DECIMAL(10, 7) NULL,
    `checkInLng` DECIMAL(10, 7) NULL,
    `checkOutLat` DECIMAL(10, 7) NULL,
    `checkOutLng` DECIMAL(10, 7) NULL,
    `checkInLocationId` CHAR(36) NULL,
    `checkOutLocationId` CHAR(36) NULL,
    `lateMinutes` INTEGER NOT NULL DEFAULT 0,
    `earlyLeaveMinutes` INTEGER NOT NULL DEFAULT 0,
    `workedMinutes` INTEGER NOT NULL DEFAULT 0,
    `breakMinutes` INTEGER NOT NULL DEFAULT 0,
    `regularMinutes` INTEGER NOT NULL DEFAULT 0,
    `overtimeMinutes` INTEGER NOT NULL DEFAULT 0,
    `overtimeApprovedMinutes` INTEGER NOT NULL DEFAULT 0,
    `overtimeStatus` VARCHAR(20) NOT NULL DEFAULT 'NONE',
    `dayType` VARCHAR(20) NOT NULL DEFAULT 'WORKDAY',
    `status` VARCHAR(20) NOT NULL DEFAULT 'INCOMPLETE',
    `approvalStatus` VARCHAR(20) NOT NULL DEFAULT 'NOT_REQUIRED',
    `isManual` BOOLEAN NOT NULL DEFAULT false,
    `isSuspicious` BOOLEAN NOT NULL DEFAULT false,
    `flags` JSON NULL,
    `notes` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `attendance_records_companyId_date_idx`(`companyId`, `date`),
    INDEX `attendance_records_companyId_status_date_idx`(`companyId`, `status`, `date`),
    UNIQUE INDEX `attendance_records_employeeId_date_key`(`employeeId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_events` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `employeeId` CHAR(36) NOT NULL,
    `recordId` CHAR(36) NOT NULL,
    `type` VARCHAR(20) NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `method` VARCHAR(20) NOT NULL,
    `latitude` DECIMAL(10, 7) NULL,
    `longitude` DECIMAL(10, 7) NULL,
    `accuracy` DECIMAL(8, 2) NULL,
    `distanceMeters` INTEGER NULL,
    `locationId` CHAR(36) NULL,
    `deviceId` CHAR(36) NULL,
    `deviceInfo` VARCHAR(300) NULL,
    `qrTokenId` CHAR(36) NULL,
    `ip` VARCHAR(64) NULL,
    `isSuspicious` BOOLEAN NOT NULL DEFAULT false,
    `flags` JSON NULL,
    `isVoided` BOOLEAN NOT NULL DEFAULT false,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `attendance_events_companyId_occurredAt_idx`(`companyId`, `occurredAt`),
    INDEX `attendance_events_recordId_idx`(`recordId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_corrections` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `employeeId` CHAR(36) NOT NULL,
    `recordId` CHAR(36) NULL,
    `date` DATE NOT NULL,
    `type` VARCHAR(20) NOT NULL DEFAULT 'CORRECTION',
    `originalCheckIn` DATETIME(3) NULL,
    `originalCheckOut` DATETIME(3) NULL,
    `requestedCheckIn` DATETIME(3) NULL,
    `requestedCheckOut` DATETIME(3) NULL,
    `reason` VARCHAR(1000) NOT NULL,
    `attachmentId` CHAR(36) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    `approvalInstanceId` CHAR(36) NULL,
    `createdById` CHAR(36) NULL,
    `decidedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `attendance_corrections_companyId_status_idx`(`companyId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `holiday_calendars` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `branchId` CHAR(36) NULL,
    `date` DATE NOT NULL,
    `nameAr` VARCHAR(200) NOT NULL,
    `nameEn` VARCHAR(200) NOT NULL,
    `isPaid` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `holiday_calendars_companyId_date_idx`(`companyId`, `date`),
    UNIQUE INDEX `holiday_calendars_companyId_branchId_date_key`(`companyId`, `branchId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shifts` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `branchId` CHAR(36) NULL,
    `code` VARCHAR(40) NOT NULL,
    `nameAr` VARCHAR(150) NOT NULL,
    `nameEn` VARCHAR(150) NOT NULL,
    `type` VARCHAR(20) NOT NULL DEFAULT 'FIXED',
    `startTime` VARCHAR(5) NOT NULL,
    `endTime` VARCHAR(5) NOT NULL,
    `crossesMidnight` BOOLEAN NOT NULL DEFAULT false,
    `breakMinutes` INTEGER NOT NULL DEFAULT 60,
    `graceMinutes` INTEGER NULL,
    `expectedMinutes` INTEGER NOT NULL,
    `workingDays` JSON NOT NULL,
    `overtimeAfterMinutes` INTEGER NULL,
    `departmentIds` JSON NULL,
    `color` VARCHAR(9) NOT NULL DEFAULT '#5A4293',
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `shifts_companyId_code_key`(`companyId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shift_assignments` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `employeeId` CHAR(36) NOT NULL,
    `shiftId` CHAR(36) NOT NULL,
    `branchId` CHAR(36) NULL,
    `date` DATE NOT NULL,
    `startAt` DATETIME(3) NOT NULL,
    `endAt` DATETIME(3) NOT NULL,
    `managerId` CHAR(36) NULL,
    `source` VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
    `status` VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED',
    `notes` VARCHAR(500) NULL,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `shift_assignments_companyId_date_idx`(`companyId`, `date`),
    INDEX `shift_assignments_employeeId_startAt_endAt_idx`(`employeeId`, `startAt`, `endAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shift_rotation_rules` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `type` VARCHAR(20) NOT NULL,
    `pattern` JSON NOT NULL,
    `blockDays` INTEGER NOT NULL DEFAULT 7,
    `startDate` DATE NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shift_exchange_requests` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `requesterId` CHAR(36) NOT NULL,
    `replacementId` CHAR(36) NOT NULL,
    `requesterAssignmentId` CHAR(36) NOT NULL,
    `replacementAssignmentId` CHAR(36) NULL,
    `date` DATE NOT NULL,
    `reason` VARCHAR(1000) NULL,
    `replacementConsent` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    `approvalInstanceId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `shift_exchange_requests_companyId_status_idx`(`companyId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shift_coverage_requirements` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `branchId` CHAR(36) NOT NULL,
    `shiftId` CHAR(36) NOT NULL,
    `dayOfWeek` INTEGER NULL,
    `minEmployees` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `shift_coverage_requirements_companyId_branchId_shiftId_dayOf_key`(`companyId`, `branchId`, `shiftId`, `dayOfWeek`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_types` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `nameAr` VARCHAR(150) NOT NULL,
    `nameEn` VARCHAR(150) NOT NULL,
    `category` VARCHAR(30) NOT NULL DEFAULT 'CUSTOM',
    `isPaid` BOOLEAN NOT NULL DEFAULT true,
    `payPercent` DECIMAL(5, 2) NOT NULL DEFAULT 100,
    `color` VARCHAR(9) NOT NULL DEFAULT '#5A4293',
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `leave_types_companyId_code_key`(`companyId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_policies` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `leaveTypeId` CHAR(36) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `annualEntitlement` DECIMAL(8, 2) NOT NULL DEFAULT 0,
    `accrualMethod` VARCHAR(20) NOT NULL DEFAULT 'UPFRONT',
    `accrualFrequency` VARCHAR(20) NOT NULL DEFAULT 'YEARLY',
    `prorateFirstYear` BOOLEAN NOT NULL DEFAULT true,
    `carryForwardMax` DECIMAL(8, 2) NULL,
    `maxBalance` DECIMAL(8, 2) NULL,
    `minRequestDays` DECIMAL(8, 2) NULL,
    `maxRequestDays` DECIMAL(8, 2) NULL,
    `attachmentRequired` BOOLEAN NOT NULL DEFAULT false,
    `attachmentAfterDays` DECIMAL(8, 2) NULL,
    `countWeekends` BOOLEAN NOT NULL DEFAULT false,
    `countHolidays` BOOLEAN NOT NULL DEFAULT false,
    `requiresBalance` BOOLEAN NOT NULL DEFAULT true,
    `allowNegativeBalance` BOOLEAN NOT NULL DEFAULT false,
    `reserveOnPending` BOOLEAN NOT NULL DEFAULT true,
    `minServiceMonths` INTEGER NULL,
    `genderRestriction` VARCHAR(10) NULL,
    `applicableBranchIds` JSON NULL,
    `applicableEmploymentTypes` JSON NULL,
    `allowCancellationAfterStart` BOOLEAN NOT NULL DEFAULT false,
    `workflowId` CHAR(36) NULL,
    `effectiveFrom` DATE NOT NULL,
    `effectiveTo` DATE NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `leave_policies_companyId_leaveTypeId_idx`(`companyId`, `leaveTypeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_balances` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `employeeId` CHAR(36) NOT NULL,
    `leaveTypeId` CHAR(36) NOT NULL,
    `year` INTEGER NOT NULL,
    `openingBalance` DECIMAL(8, 2) NOT NULL DEFAULT 0,
    `accrued` DECIMAL(8, 2) NOT NULL DEFAULT 0,
    `used` DECIMAL(8, 2) NOT NULL DEFAULT 0,
    `pending` DECIMAL(8, 2) NOT NULL DEFAULT 0,
    `carriedForward` DECIMAL(8, 2) NOT NULL DEFAULT 0,
    `adjustments` DECIMAL(8, 2) NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `leave_balances_companyId_year_idx`(`companyId`, `year`),
    UNIQUE INDEX `leave_balances_employeeId_leaveTypeId_year_key`(`employeeId`, `leaveTypeId`, `year`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_balance_transactions` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `balanceId` CHAR(36) NOT NULL,
    `type` VARCHAR(30) NOT NULL,
    `days` DECIMAL(8, 2) NOT NULL,
    `refType` VARCHAR(40) NULL,
    `refId` CHAR(36) NULL,
    `note` VARCHAR(500) NULL,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `leave_balance_transactions_balanceId_idx`(`balanceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_requests` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `employeeId` CHAR(36) NOT NULL,
    `leaveTypeId` CHAR(36) NOT NULL,
    `policyId` CHAR(36) NULL,
    `startDate` DATE NOT NULL,
    `endDate` DATE NOT NULL,
    `halfDay` BOOLEAN NOT NULL DEFAULT false,
    `days` DECIMAL(8, 2) NOT NULL,
    `reason` VARCHAR(1000) NULL,
    `attachmentId` CHAR(36) NULL,
    `emergencyContact` VARCHAR(200) NULL,
    `handoverNotes` VARCHAR(1000) NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
    `approvalInstanceId` CHAR(36) NULL,
    `submittedAt` DATETIME(3) NULL,
    `decidedAt` DATETIME(3) NULL,
    `cancelReason` VARCHAR(500) NULL,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `leave_requests_companyId_status_idx`(`companyId`, `status`),
    INDEX `leave_requests_companyId_startDate_endDate_idx`(`companyId`, `startDate`, `endDate`),
    INDEX `leave_requests_employeeId_startDate_idx`(`employeeId`, `startDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `approval_workflows` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `code` VARCHAR(60) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `entityType` VARCHAR(40) NOT NULL,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `priority` INTEGER NOT NULL DEFAULT 0,
    `conditions` JSON NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `approval_workflows_companyId_entityType_idx`(`companyId`, `entityType`),
    UNIQUE INDEX `approval_workflows_companyId_code_key`(`companyId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `approval_steps` (
    `id` CHAR(36) NOT NULL,
    `workflowId` CHAR(36) NOT NULL,
    `stepOrder` INTEGER NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `approverType` VARCHAR(30) NOT NULL,
    `roleCode` VARCHAR(60) NULL,
    `userId` CHAR(36) NULL,
    `mode` VARCHAR(10) NOT NULL DEFAULT 'ANY',
    `condition` JSON NULL,
    `pendingStatus` VARCHAR(30) NULL,

    UNIQUE INDEX `approval_steps_workflowId_stepOrder_key`(`workflowId`, `stepOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `approval_instances` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `workflowId` CHAR(36) NOT NULL,
    `entityType` VARCHAR(40) NOT NULL,
    `entityId` CHAR(36) NOT NULL,
    `requesterUserId` CHAR(36) NULL,
    `requesterEmployeeId` CHAR(36) NULL,
    `amount` DECIMAL(14, 2) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    `currentStep` INTEGER NOT NULL DEFAULT 1,
    `summary` VARCHAR(300) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    INDEX `approval_instances_companyId_entityType_entityId_idx`(`companyId`, `entityType`, `entityId`),
    INDEX `approval_instances_companyId_status_idx`(`companyId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `approval_tasks` (
    `id` CHAR(36) NOT NULL,
    `instanceId` CHAR(36) NOT NULL,
    `stepOrder` INTEGER NOT NULL,
    `stepName` VARCHAR(150) NOT NULL,
    `mode` VARCHAR(10) NOT NULL DEFAULT 'ANY',
    `approverUserId` CHAR(36) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'WAITING',
    `comment` VARCHAR(1000) NULL,
    `actedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `approval_tasks_approverUserId_status_idx`(`approverUserId`, `status`),
    INDEX `approval_tasks_instanceId_idx`(`instanceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_settings` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `frequency` VARCHAR(20) NOT NULL DEFAULT 'MONTHLY',
    `cutoffDay` INTEGER NOT NULL DEFAULT 25,
    `paymentDay` INTEGER NOT NULL DEFAULT 27,
    `daysBasis` VARCHAR(20) NOT NULL DEFAULT 'FIXED',
    `fixedDaysPerMonth` INTEGER NOT NULL DEFAULT 30,
    `standardDailyHours` DECIMAL(5, 2) NOT NULL DEFAULT 8,
    `overtimeBase` VARCHAR(30) NOT NULL DEFAULT 'BASIC',
    `overtimeRateWeekday` DECIMAL(6, 3) NOT NULL DEFAULT 1.5,
    `overtimeRateWeekend` DECIMAL(6, 3) NOT NULL DEFAULT 1.5,
    `overtimeRateHoliday` DECIMAL(6, 3) NOT NULL DEFAULT 1.5,
    `absenceDeductionEnabled` BOOLEAN NOT NULL DEFAULT true,
    `absenceDeductionBase` VARCHAR(30) NOT NULL DEFAULT 'FLAGGED_COMPONENTS',
    `lateDeductionMode` VARCHAR(20) NOT NULL DEFAULT 'NONE',
    `lateFreeMinutesPerPeriod` INTEGER NOT NULL DEFAULT 0,
    `earlyLeaveDeduction` BOOLEAN NOT NULL DEFAULT false,
    `unpaidLeaveDeduction` BOOLEAN NOT NULL DEFAULT true,
    `roundingDecimals` INTEGER NOT NULL DEFAULT 2,
    `roundingMode` VARCHAR(20) NOT NULL DEFAULT 'HALF_UP',
    `maxDeductionPercent` DECIMAL(5, 2) NULL,
    `gosiEmployeeRate` DECIMAL(6, 3) NOT NULL DEFAULT 0,
    `gosiEmployerRate` DECIMAL(6, 3) NOT NULL DEFAULT 0,
    `gosiNationalities` JSON NULL,
    `commissionInclusion` VARCHAR(40) NOT NULL DEFAULT 'APPROVED_BY_PERIOD_END',
    `bankExportFormat` JSON NULL,
    `workflowId` CHAR(36) NULL,
    `eosRules` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payroll_settings_companyId_key`(`companyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `salary_components` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `nameAr` VARCHAR(150) NOT NULL,
    `nameEn` VARCHAR(150) NOT NULL,
    `type` VARCHAR(20) NOT NULL,
    `category` VARCHAR(30) NOT NULL,
    `calculationMethod` VARCHAR(30) NOT NULL DEFAULT 'EMPLOYEE_AMOUNT',
    `value` DECIMAL(14, 4) NULL,
    `baseComponentCode` VARCHAR(40) NULL,
    `formula` VARCHAR(500) NULL,
    `isTaxable` BOOLEAN NOT NULL DEFAULT false,
    `includeInOvertimeBase` BOOLEAN NOT NULL DEFAULT false,
    `includeInEosBase` BOOLEAN NOT NULL DEFAULT false,
    `includeInGosiBase` BOOLEAN NOT NULL DEFAULT false,
    `includeInAbsenceBase` BOOLEAN NOT NULL DEFAULT false,
    `prorate` BOOLEAN NOT NULL DEFAULT true,
    `isSystem` BOOLEAN NOT NULL DEFAULT false,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `effectiveFrom` DATE NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `salary_components_companyId_code_key`(`companyId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `salary_structures` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `salary_structures_companyId_code_key`(`companyId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `salary_structure_lines` (
    `id` CHAR(36) NOT NULL,
    `structureId` CHAR(36) NOT NULL,
    `componentId` CHAR(36) NOT NULL,
    `calculationMethod` VARCHAR(30) NULL,
    `value` DECIMAL(14, 4) NULL,
    `baseComponentCode` VARCHAR(40) NULL,
    `formula` VARCHAR(500) NULL,

    UNIQUE INDEX `salary_structure_lines_structureId_componentId_key`(`structureId`, `componentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_periods` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `frequency` VARCHAR(20) NOT NULL DEFAULT 'MONTHLY',
    `startDate` DATE NOT NULL,
    `endDate` DATE NOT NULL,
    `paymentDate` DATE NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payroll_periods_companyId_startDate_endDate_frequency_key`(`companyId`, `startDate`, `endDate`, `frequency`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_runs` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `periodId` CHAR(36) NOT NULL,
    `branchId` CHAR(36) NULL,
    `runNumber` VARCHAR(40) NOT NULL,
    `type` VARCHAR(20) NOT NULL DEFAULT 'REGULAR',
    `status` VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    `employeeFilter` JSON NULL,
    `employeesCount` INTEGER NOT NULL DEFAULT 0,
    `totalBasic` DECIMAL(16, 2) NOT NULL DEFAULT 0,
    `totalEarnings` DECIMAL(16, 2) NOT NULL DEFAULT 0,
    `totalDeductions` DECIMAL(16, 2) NOT NULL DEFAULT 0,
    `totalOvertime` DECIMAL(16, 2) NOT NULL DEFAULT 0,
    `totalCommissions` DECIMAL(16, 2) NOT NULL DEFAULT 0,
    `totalNet` DECIMAL(16, 2) NOT NULL DEFAULT 0,
    `currency` VARCHAR(3) NOT NULL DEFAULT 'SAR',
    `approvalInstanceId` CHAR(36) NULL,
    `reversalOfId` CHAR(36) NULL,
    `calculatedAt` DATETIME(3) NULL,
    `approvedAt` DATETIME(3) NULL,
    `lockedAt` DATETIME(3) NULL,
    `createdById` CHAR(36) NULL,
    `notes` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `payroll_runs_companyId_status_idx`(`companyId`, `status`),
    UNIQUE INDEX `payroll_runs_companyId_runNumber_key`(`companyId`, `runNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_run_employees` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `runId` CHAR(36) NOT NULL,
    `employeeId` CHAR(36) NOT NULL,
    `snapshot` JSON NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'INCLUDED',
    `excludeReason` VARCHAR(500) NULL,
    `periodDays` DECIMAL(8, 2) NOT NULL DEFAULT 0,
    `paidDays` DECIMAL(8, 2) NOT NULL DEFAULT 0,
    `absentDays` DECIMAL(8, 2) NOT NULL DEFAULT 0,
    `unpaidLeaveDays` DECIMAL(8, 2) NOT NULL DEFAULT 0,
    `lateMinutes` INTEGER NOT NULL DEFAULT 0,
    `overtimeMinutes` INTEGER NOT NULL DEFAULT 0,
    `basicSalary` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `grossEarnings` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `totalDeductions` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `netSalary` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `warnings` JSON NULL,
    `errors` JSON NULL,
    `paymentStatus` VARCHAR(20) NOT NULL DEFAULT 'UNPAID',
    `paymentReference` VARCHAR(120) NULL,
    `paidAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `payroll_run_employees_companyId_employeeId_idx`(`companyId`, `employeeId`),
    UNIQUE INDEX `payroll_run_employees_runId_employeeId_key`(`runId`, `employeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_lines` (
    `id` CHAR(36) NOT NULL,
    `runEmployeeId` CHAR(36) NOT NULL,
    `componentId` CHAR(36) NULL,
    `code` VARCHAR(40) NOT NULL,
    `nameAr` VARCHAR(150) NOT NULL,
    `nameEn` VARCHAR(150) NOT NULL,
    `type` VARCHAR(20) NOT NULL,
    `category` VARCHAR(30) NOT NULL,
    `quantity` DECIMAL(12, 4) NULL,
    `rate` DECIMAL(14, 4) NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `sourceType` VARCHAR(30) NOT NULL,
    `sourceId` CHAR(36) NULL,
    `meta` JSON NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `payroll_lines_runEmployeeId_idx`(`runEmployeeId`),
    INDEX `payroll_lines_sourceType_sourceId_idx`(`sourceType`, `sourceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_adjustments` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `employeeId` CHAR(36) NOT NULL,
    `componentId` CHAR(36) NULL,
    `type` VARCHAR(20) NOT NULL,
    `category` VARCHAR(30) NOT NULL DEFAULT 'OTHER_EARNING',
    `amount` DECIMAL(14, 2) NOT NULL,
    `effectiveDate` DATE NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `originalRunId` CHAR(36) NULL,
    `appliedRunId` CHAR(36) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    `createdById` CHAR(36) NULL,
    `approvedById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `payroll_adjustments_companyId_status_idx`(`companyId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_payments` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `runId` CHAR(36) NOT NULL,
    `runEmployeeId` CHAR(36) NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `method` VARCHAR(20) NOT NULL,
    `bankName` VARCHAR(120) NULL,
    `iban` VARCHAR(34) NULL,
    `reference` VARCHAR(120) NULL,
    `paidAt` DATETIME(3) NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'PAID',
    `recordedById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `payroll_payments_runId_idx`(`runId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payslips` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `runEmployeeId` CHAR(36) NOT NULL,
    `runId` CHAR(36) NOT NULL,
    `employeeId` CHAR(36) NOT NULL,
    `number` VARCHAR(40) NOT NULL,
    `periodStart` DATE NOT NULL,
    `periodEnd` DATE NOT NULL,
    `paymentDate` DATE NOT NULL,
    `grossEarnings` DECIMAL(14, 2) NOT NULL,
    `totalDeductions` DECIMAL(14, 2) NOT NULL,
    `netSalary` DECIMAL(14, 2) NOT NULL,
    `currency` VARCHAR(3) NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ISSUED',
    `issuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payslips_runEmployeeId_key`(`runEmployeeId`),
    INDEX `payslips_companyId_employeeId_periodStart_idx`(`companyId`, `employeeId`, `periodStart`),
    UNIQUE INDEX `payslips_companyId_number_key`(`companyId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payslip_download_logs` (
    `id` CHAR(36) NOT NULL,
    `payslipId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `format` VARCHAR(10) NOT NULL,
    `ip` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `payslip_download_logs_payslipId_idx`(`payslipId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `commission_rules` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `nameAr` VARCHAR(150) NOT NULL,
    `nameEn` VARCHAR(150) NOT NULL,
    `type` VARCHAR(30) NOT NULL,
    `calculationBase` VARCHAR(30) NOT NULL,
    `value` DECIMAL(14, 4) NOT NULL DEFAULT 0,
    `tierMode` VARCHAR(20) NULL,
    `minTarget` DECIMAL(14, 2) NULL,
    `maxTarget` DECIMAL(14, 2) NULL,
    `maxCommission` DECIMAL(14, 2) NULL,
    `employeeIds` JSON NULL,
    `positionIds` JSON NULL,
    `departmentIds` JSON NULL,
    `branchIds` JSON NULL,
    `serviceCategory` VARCHAR(100) NULL,
    `serviceCode` VARCHAR(100) NULL,
    `conditions` JSON NULL,
    `requiresApproval` BOOLEAN NOT NULL DEFAULT true,
    `participantRole` VARCHAR(30) NOT NULL DEFAULT 'ANY',
    `effectiveFrom` DATE NOT NULL,
    `expiryDate` DATE NULL,
    `priority` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `commission_rules_companyId_code_key`(`companyId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `commission_tiers` (
    `id` CHAR(36) NOT NULL,
    `ruleId` CHAR(36) NOT NULL,
    `fromAmount` DECIMAL(14, 2) NOT NULL,
    `toAmount` DECIMAL(14, 2) NULL,
    `rate` DECIMAL(9, 4) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `commission_source_transactions` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `branchId` CHAR(36) NULL,
    `sourceSystem` VARCHAR(30) NOT NULL DEFAULT 'MANUAL',
    `externalRef` VARCHAR(120) NOT NULL,
    `transactionDate` DATE NOT NULL,
    `serviceCategory` VARCHAR(100) NULL,
    `serviceCode` VARCHAR(100) NULL,
    `serviceName` VARCHAR(200) NULL,
    `salesAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `collectedAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `netProfit` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `taskCount` INTEGER NOT NULL DEFAULT 1,
    `isCompleted` BOOLEAN NOT NULL DEFAULT true,
    `qualityApproved` BOOLEAN NOT NULL DEFAULT false,
    `invoiceIssued` BOOLEAN NOT NULL DEFAULT false,
    `invoiceCollected` BOOLEAN NOT NULL DEFAULT false,
    `isCancelled` BOOLEAN NOT NULL DEFAULT false,
    `isRefunded` BOOLEAN NOT NULL DEFAULT false,
    `status` VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `commission_source_transactions_companyId_transactionDate_idx`(`companyId`, `transactionDate`),
    UNIQUE INDEX `commission_source_transactions_companyId_externalRef_key`(`companyId`, `externalRef`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `commission_distributions` (
    `id` CHAR(36) NOT NULL,
    `transactionId` CHAR(36) NOT NULL,
    `employeeId` CHAR(36) NOT NULL,
    `role` VARCHAR(30) NOT NULL DEFAULT 'TECHNICIAN',
    `sharePercent` DECIMAL(7, 4) NOT NULL,

    UNIQUE INDEX `commission_distributions_transactionId_employeeId_role_key`(`transactionId`, `employeeId`, `role`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `commission_transactions` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `employeeId` CHAR(36) NOT NULL,
    `ruleId` CHAR(36) NULL,
    `sourceTransactionId` CHAR(36) NULL,
    `branchId` CHAR(36) NULL,
    `serviceCode` VARCHAR(100) NULL,
    `periodKey` VARCHAR(10) NULL,
    `entryType` VARCHAR(20) NOT NULL DEFAULT 'ACCRUAL',
    `calculationBase` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `rate` DECIMAL(9, 4) NULL,
    `sharePercent` DECIMAL(7, 4) NOT NULL DEFAULT 100,
    `grossAmount` DECIMAL(14, 2) NOT NULL,
    `adjustments` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `netAmount` DECIMAL(14, 2) NOT NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'CALCULATED',
    `dedupeKey` VARCHAR(191) NULL,
    `reversalOfId` CHAR(36) NULL,
    `payrollRunId` CHAR(36) NULL,
    `approvedById` CHAR(36) NULL,
    `approvedAt` DATETIME(3) NULL,
    `holdReason` VARCHAR(500) NULL,
    `notes` VARCHAR(1000) NULL,
    `earnedDate` DATE NOT NULL,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `commission_transactions_companyId_status_idx`(`companyId`, `status`),
    INDEX `commission_transactions_employeeId_status_idx`(`employeeId`, `status`),
    UNIQUE INDEX `commission_transactions_companyId_dedupeKey_key`(`companyId`, `dedupeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_advances` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `employeeId` CHAR(36) NOT NULL,
    `number` VARCHAR(40) NOT NULL,
    `requestDate` DATE NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `approvedAmount` DECIMAL(14, 2) NULL,
    `reason` VARCHAR(1000) NULL,
    `requestedPaymentDate` DATE NULL,
    `attachmentId` CHAR(36) NULL,
    `repaymentMethod` VARCHAR(20) NOT NULL DEFAULT 'PAYROLL',
    `installmentCount` INTEGER NOT NULL DEFAULT 1,
    `firstDeductionDate` DATE NULL,
    `notes` VARCHAR(1000) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    `approvalInstanceId` CHAR(36) NULL,
    `disbursedAt` DATETIME(3) NULL,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `employee_advances_companyId_status_idx`(`companyId`, `status`),
    UNIQUE INDEX `employee_advances_companyId_number_key`(`companyId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_loans` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `employeeId` CHAR(36) NOT NULL,
    `number` VARCHAR(40) NOT NULL,
    `loanType` VARCHAR(30) NOT NULL DEFAULT 'PERSONAL',
    `amount` DECIMAL(14, 2) NOT NULL,
    `approvedAmount` DECIMAL(14, 2) NULL,
    `feeAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `reason` VARCHAR(1000) NULL,
    `requestDate` DATE NOT NULL,
    `approvalDate` DATE NULL,
    `disbursementDate` DATE NULL,
    `installmentCount` INTEGER NOT NULL,
    `monthlyInstallment` DECIMAL(14, 2) NULL,
    `firstDeductionDate` DATE NULL,
    `repaymentMethod` VARCHAR(20) NOT NULL DEFAULT 'PAYROLL',
    `attachmentId` CHAR(36) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    `approvalInstanceId` CHAR(36) NULL,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `employee_loans_companyId_status_idx`(`companyId`, `status`),
    UNIQUE INDEX `employee_loans_companyId_number_key`(`companyId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `loan_installments` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `employeeId` CHAR(36) NOT NULL,
    `advanceId` CHAR(36) NULL,
    `loanId` CHAR(36) NULL,
    `number` INTEGER NOT NULL,
    `dueDate` DATE NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `paidAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `status` VARCHAR(20) NOT NULL DEFAULT 'UPCOMING',
    `deferredToId` CHAR(36) NULL,
    `notes` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `loan_installments_companyId_employeeId_dueDate_idx`(`companyId`, `employeeId`, `dueDate`),
    INDEX `loan_installments_advanceId_idx`(`advanceId`),
    INDEX `loan_installments_loanId_idx`(`loanId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_financial_ledger` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `employeeId` CHAR(36) NOT NULL,
    `advanceId` CHAR(36) NULL,
    `loanId` CHAR(36) NULL,
    `installmentId` CHAR(36) NULL,
    `type` VARCHAR(30) NOT NULL,
    `debit` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `credit` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `balanceAfter` DECIMAL(14, 2) NOT NULL,
    `payrollRunId` CHAR(36) NULL,
    `reversalOfId` CHAR(36) NULL,
    `note` VARCHAR(500) NULL,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `employee_financial_ledger_companyId_employeeId_createdAt_idx`(`companyId`, `employeeId`, `createdAt`),
    INDEX `employee_financial_ledger_advanceId_idx`(`advanceId`),
    INDEX `employee_financial_ledger_loanId_idx`(`loanId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_settlements` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `employeeId` CHAR(36) NOT NULL,
    `terminationDate` DATE NOT NULL,
    `reason` VARCHAR(500) NULL,
    `outstandingBalance` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `unpaidInstallments` INTEGER NOT NULL DEFAULT 0,
    `eosAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `leaveEncashment` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `otherDues` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `agreedDeduction` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `netSettlement` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `details` JSON NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    `reviewedById` CHAR(36) NULL,
    `approvedById` CHAR(36) NULL,
    `notes` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `employee_settlements_companyId_status_idx`(`companyId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifications` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NULL,
    `userId` CHAR(36) NOT NULL,
    `type` VARCHAR(60) NOT NULL,
    `params` JSON NULL,
    `link` VARCHAR(300) NULL,
    `channel` VARCHAR(20) NOT NULL DEFAULT 'IN_APP',
    `readAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notifications_userId_readAt_idx`(`userId`, `readAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_preferences` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `type` VARCHAR(60) NOT NULL,
    `inApp` BOOLEAN NOT NULL DEFAULT true,
    `email` BOOLEAN NOT NULL DEFAULT false,
    `sms` BOOLEAN NOT NULL DEFAULT false,
    `whatsapp` BOOLEAN NOT NULL DEFAULT false,
    `push` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `notification_preferences_userId_type_key`(`userId`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `outbound_messages` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NULL,
    `channel` VARCHAR(20) NOT NULL,
    `recipient` VARCHAR(191) NOT NULL,
    `subject` VARCHAR(300) NULL,
    `body` TEXT NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
    `error` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sentAt` DATETIME(3) NULL,

    INDEX `outbound_messages_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NULL,
    `userId` CHAR(36) NULL,
    `userName` VARCHAR(200) NULL,
    `action` VARCHAR(60) NOT NULL,
    `entityType` VARCHAR(60) NOT NULL,
    `entityId` CHAR(36) NULL,
    `employeeId` CHAR(36) NULL,
    `oldValue` JSON NULL,
    `newValue` JSON NULL,
    `reason` VARCHAR(500) NULL,
    `ip` VARCHAR(64) NULL,
    `userAgent` VARCHAR(300) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_companyId_entityType_entityId_idx`(`companyId`, `entityType`, `entityId`),
    INDEX `audit_logs_companyId_employeeId_idx`(`companyId`, `employeeId`),
    INDEX `audit_logs_companyId_createdAt_idx`(`companyId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `system_settings` (
    `id` CHAR(36) NOT NULL,
    `companyId` CHAR(36) NOT NULL,
    `key` VARCHAR(100) NOT NULL,
    `value` JSON NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `system_settings_companyId_key_key`(`companyId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sequences` (
    `companyId` CHAR(36) NOT NULL,
    `name` VARCHAR(40) NOT NULL,
    `value` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`companyId`, `name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `branches` ADD CONSTRAINT `branches_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `branches` ADD CONSTRAINT `branches_managerId_fkey` FOREIGN KEY (`managerId`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refresh_tokens` ADD CONSTRAINT `refresh_tokens_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `roles` ADD CONSTRAINT `roles_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `roles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_permissionId_fkey` FOREIGN KEY (`permissionId`) REFERENCES `permissions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `roles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `departments` ADD CONSTRAINT `departments_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `departments` ADD CONSTRAINT `departments_branchId_fkey` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `departments` ADD CONSTRAINT `departments_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `departments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `departments` ADD CONSTRAINT `departments_managerId_fkey` FOREIGN KEY (`managerId`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `teams` ADD CONSTRAINT `teams_departmentId_fkey` FOREIGN KEY (`departmentId`) REFERENCES `departments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `teams` ADD CONSTRAINT `teams_leaderId_fkey` FOREIGN KEY (`leaderId`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_positions` ADD CONSTRAINT `job_positions_departmentId_fkey` FOREIGN KEY (`departmentId`) REFERENCES `departments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_positions` ADD CONSTRAINT `job_positions_gradeId_fkey` FOREIGN KEY (`gradeId`) REFERENCES `job_grades`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_positions` ADD CONSTRAINT `job_positions_reportsToPositionId_fkey` FOREIGN KEY (`reportsToPositionId`) REFERENCES `job_positions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_branchId_fkey` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_departmentId_fkey` FOREIGN KEY (`departmentId`) REFERENCES `departments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_sectionId_fkey` FOREIGN KEY (`sectionId`) REFERENCES `departments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `teams`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_positionId_fkey` FOREIGN KEY (`positionId`) REFERENCES `job_positions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_gradeId_fkey` FOREIGN KEY (`gradeId`) REFERENCES `job_grades`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_managerId_fkey` FOREIGN KEY (`managerId`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_defaultShiftId_fkey` FOREIGN KEY (`defaultShiftId`) REFERENCES `shifts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_attendancePolicyId_fkey` FOREIGN KEY (`attendancePolicyId`) REFERENCES `attendance_policies`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_salaryStructureId_fkey` FOREIGN KEY (`salaryStructureId`) REFERENCES `salary_structures`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_emergency_contacts` ADD CONSTRAINT `employee_emergency_contacts_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_employment_history` ADD CONSTRAINT `employee_employment_history_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_salary_revisions` ADD CONSTRAINT `employee_salary_revisions_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_salary_components` ADD CONSTRAINT `employee_salary_components_revisionId_fkey` FOREIGN KEY (`revisionId`) REFERENCES `employee_salary_revisions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_salary_components` ADD CONSTRAINT `employee_salary_components_componentId_fkey` FOREIGN KEY (`componentId`) REFERENCES `salary_components`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_documents` ADD CONSTRAINT `employee_documents_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_documents` ADD CONSTRAINT `employee_documents_fileId_fkey` FOREIGN KEY (`fileId`) REFERENCES `file_attachments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_locations` ADD CONSTRAINT `attendance_locations_branchId_fkey` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_shiftId_fkey` FOREIGN KEY (`shiftId`) REFERENCES `shifts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_events` ADD CONSTRAINT `attendance_events_recordId_fkey` FOREIGN KEY (`recordId`) REFERENCES `attendance_records`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_events` ADD CONSTRAINT `attendance_events_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_corrections` ADD CONSTRAINT `attendance_corrections_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_corrections` ADD CONSTRAINT `attendance_corrections_recordId_fkey` FOREIGN KEY (`recordId`) REFERENCES `attendance_records`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `shift_assignments` ADD CONSTRAINT `shift_assignments_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `shift_assignments` ADD CONSTRAINT `shift_assignments_shiftId_fkey` FOREIGN KEY (`shiftId`) REFERENCES `shifts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `shift_exchange_requests` ADD CONSTRAINT `shift_exchange_requests_requesterId_fkey` FOREIGN KEY (`requesterId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `shift_exchange_requests` ADD CONSTRAINT `shift_exchange_requests_replacementId_fkey` FOREIGN KEY (`replacementId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `shift_coverage_requirements` ADD CONSTRAINT `shift_coverage_requirements_shiftId_fkey` FOREIGN KEY (`shiftId`) REFERENCES `shifts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_policies` ADD CONSTRAINT `leave_policies_leaveTypeId_fkey` FOREIGN KEY (`leaveTypeId`) REFERENCES `leave_types`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_balances` ADD CONSTRAINT `leave_balances_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_balances` ADD CONSTRAINT `leave_balances_leaveTypeId_fkey` FOREIGN KEY (`leaveTypeId`) REFERENCES `leave_types`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_balance_transactions` ADD CONSTRAINT `leave_balance_transactions_balanceId_fkey` FOREIGN KEY (`balanceId`) REFERENCES `leave_balances`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_requests` ADD CONSTRAINT `leave_requests_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_requests` ADD CONSTRAINT `leave_requests_leaveTypeId_fkey` FOREIGN KEY (`leaveTypeId`) REFERENCES `leave_types`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_requests` ADD CONSTRAINT `leave_requests_policyId_fkey` FOREIGN KEY (`policyId`) REFERENCES `leave_policies`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_steps` ADD CONSTRAINT `approval_steps_workflowId_fkey` FOREIGN KEY (`workflowId`) REFERENCES `approval_workflows`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_instances` ADD CONSTRAINT `approval_instances_workflowId_fkey` FOREIGN KEY (`workflowId`) REFERENCES `approval_workflows`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_tasks` ADD CONSTRAINT `approval_tasks_instanceId_fkey` FOREIGN KEY (`instanceId`) REFERENCES `approval_instances`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_settings` ADD CONSTRAINT `payroll_settings_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `salary_structure_lines` ADD CONSTRAINT `salary_structure_lines_structureId_fkey` FOREIGN KEY (`structureId`) REFERENCES `salary_structures`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `salary_structure_lines` ADD CONSTRAINT `salary_structure_lines_componentId_fkey` FOREIGN KEY (`componentId`) REFERENCES `salary_components`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_periodId_fkey` FOREIGN KEY (`periodId`) REFERENCES `payroll_periods`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_run_employees` ADD CONSTRAINT `payroll_run_employees_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `payroll_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_run_employees` ADD CONSTRAINT `payroll_run_employees_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_lines` ADD CONSTRAINT `payroll_lines_runEmployeeId_fkey` FOREIGN KEY (`runEmployeeId`) REFERENCES `payroll_run_employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_adjustments` ADD CONSTRAINT `payroll_adjustments_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payments` ADD CONSTRAINT `payroll_payments_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `payroll_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payslips` ADD CONSTRAINT `payslips_runEmployeeId_fkey` FOREIGN KEY (`runEmployeeId`) REFERENCES `payroll_run_employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payslips` ADD CONSTRAINT `payslips_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payslip_download_logs` ADD CONSTRAINT `payslip_download_logs_payslipId_fkey` FOREIGN KEY (`payslipId`) REFERENCES `payslips`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `commission_tiers` ADD CONSTRAINT `commission_tiers_ruleId_fkey` FOREIGN KEY (`ruleId`) REFERENCES `commission_rules`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `commission_distributions` ADD CONSTRAINT `commission_distributions_transactionId_fkey` FOREIGN KEY (`transactionId`) REFERENCES `commission_source_transactions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `commission_distributions` ADD CONSTRAINT `commission_distributions_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `commission_transactions` ADD CONSTRAINT `commission_transactions_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `commission_transactions` ADD CONSTRAINT `commission_transactions_ruleId_fkey` FOREIGN KEY (`ruleId`) REFERENCES `commission_rules`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_advances` ADD CONSTRAINT `employee_advances_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_loans` ADD CONSTRAINT `employee_loans_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `loan_installments` ADD CONSTRAINT `loan_installments_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `loan_installments` ADD CONSTRAINT `loan_installments_advanceId_fkey` FOREIGN KEY (`advanceId`) REFERENCES `employee_advances`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `loan_installments` ADD CONSTRAINT `loan_installments_loanId_fkey` FOREIGN KEY (`loanId`) REFERENCES `employee_loans`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_financial_ledger` ADD CONSTRAINT `employee_financial_ledger_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_settlements` ADD CONSTRAINT `employee_settlements_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notification_preferences` ADD CONSTRAINT `notification_preferences_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
