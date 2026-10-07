/*
  Warnings:

  - Added the required column `divisionId` to the `CommissionPeriod` table without a default value. This is not possible if the table is not empty.
  - Added the required column `divisionId` to the `Deal` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "CommissionPeriod" ADD COLUMN     "divisionId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Deal" ADD COLUMN     "divisionId" INTEGER NOT NULL;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPeriod" ADD CONSTRAINT "CommissionPeriod_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
