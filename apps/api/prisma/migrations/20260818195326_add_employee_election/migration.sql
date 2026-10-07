-- CreateTable
CREATE TABLE "Employee" (
    "id" SERIAL NOT NULL,
    "groupId" INTEGER NOT NULL,
    "employeeSsnHash" TEXT NOT NULL,
    "employeeSsnLast4" TEXT,
    "employeeSsnPlaintext" TEXT,
    "firstName" TEXT,
    "middleName" TEXT,
    "lastName" TEXT,
    "suffix" TEXT,
    "preferredName" TEXT,
    "displayName" TEXT,
    "fullName" TEXT,
    "sex" TEXT,
    "genderIdentity" TEXT,
    "dob" DATE,
    "age" INTEGER,
    "maritalStatus" TEXT,
    "dateOfMarriage" DATE,
    "usCitizen" TEXT,
    "visaStatus" TEXT,
    "veteranStatus" TEXT,
    "militaryReserveStatus" TEXT,
    "raceEthnicity" TEXT,
    "language" TEXT,
    "driversLicenseNumber" TEXT,
    "office" TEXT,
    "class" TEXT,
    "payrollGroup" TEXT,
    "division" TEXT,
    "department" TEXT,
    "businessUnit" TEXT,
    "benefitWorkState" TEXT,
    "payrollWorkState" TEXT,
    "costCenter" TEXT,
    "isCollectivelyBargained" TEXT,
    "jobTitle" TEXT,
    "jobClassification" TEXT,
    "manager" TEXT,
    "managerEmail" TEXT,
    "demographicChangeEffectiveDate" DATE,
    "rawRow" JSONB NOT NULL,
    "sourceFileName" TEXT NOT NULL,
    "loadBatchId" TEXT NOT NULL,
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Election" (
    "id" SERIAL NOT NULL,
    "groupId" INTEGER NOT NULL,
    "employeeId" INTEGER,
    "enrollmentType" TEXT,
    "plan" TEXT,
    "carrier" TEXT,
    "benefit" TEXT,
    "coverageLevel" TEXT,
    "startDate" DATE,
    "startReason" TEXT,
    "endDate" DATE,
    "endReason" TEXT,
    "declineReason" TEXT,
    "totalMonthlyEeCost" DECIMAL(12,2),
    "totalMonthlyPlanCost" DECIMAL(12,2),
    "eeMonthlyCost" DECIMAL(12,2),
    "erMonthlyCost" DECIMAL(12,2),
    "planMonthlyCost" DECIMAL(12,2),
    "benefitAmount" DECIMAL(14,2),
    "coveredPayrollAmount" DECIMAL(14,2),
    "eePerPayCost" DECIMAL(12,2),
    "erPerPayCost" DECIMAL(12,2),
    "eligibleDate" DATE,
    "enrolledOn" DATE,
    "endedOn" DATE,
    "lastUpdatedBy" TEXT,
    "lastUpdatedDate" DATE,
    "pcpName" TEXT,
    "pcpId" TEXT,
    "pcpType" TEXT,
    "baseErCost" DECIMAL(12,2),
    "pcpCurrentPatient" TEXT,
    "benefitAllowance" DECIMAL(12,2),
    "pendingEeCost" DECIMAL(12,2),
    "pendingBenefitAmount" DECIMAL(14,2),
    "pendingCoveredPayrollAmount" DECIMAL(14,2),
    "planPolicyNumber" TEXT,
    "carrierTobaccoOverride" TEXT,
    "enrolledBy" TEXT,
    "rawRow" JSONB NOT NULL,
    "groupNameRaw" TEXT NOT NULL,
    "sourceFileName" TEXT NOT NULL,
    "loadBatchId" TEXT NOT NULL,
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Election_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Employee_sourceFileName_idx" ON "Employee"("sourceFileName");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_groupId_employeeSsnHash_key" ON "Employee"("groupId", "employeeSsnHash");

-- CreateIndex
CREATE INDEX "Election_groupId_idx" ON "Election"("groupId");

-- CreateIndex
CREATE INDEX "Election_employeeId_idx" ON "Election"("employeeId");

-- CreateIndex
CREATE INDEX "Election_sourceFileName_idx" ON "Election"("sourceFileName");

-- CreateIndex
CREATE INDEX "Election_loadBatchId_idx" ON "Election"("loadBatchId");

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Election" ADD CONSTRAINT "Election_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Election" ADD CONSTRAINT "Election_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
