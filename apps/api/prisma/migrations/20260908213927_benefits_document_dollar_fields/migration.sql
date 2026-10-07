-- AlterTable
ALTER TABLE "BenefitsDocumentEntry" ADD COLUMN     "benefitAmount" DECIMAL(14,2),
ADD COLUMN     "carrierNameConfirmed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "coveredPayrollAmount" DECIMAL(14,2),
ADD COLUMN     "employeeId" INTEGER,
ADD COLUMN     "employeeMonthlyCost" DECIMAL(12,2),
ADD COLUMN     "employeePerPayCost" DECIMAL(12,2),
ADD COLUMN     "employeeSsnHash" TEXT,
ADD COLUMN     "employerMonthlyCost" DECIMAL(12,2);

-- CreateIndex
CREATE INDEX "BenefitsDocumentEntry_employeeSsnHash_idx" ON "BenefitsDocumentEntry"("employeeSsnHash");

-- AddForeignKey
ALTER TABLE "BenefitsDocumentEntry" ADD CONSTRAINT "BenefitsDocumentEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
