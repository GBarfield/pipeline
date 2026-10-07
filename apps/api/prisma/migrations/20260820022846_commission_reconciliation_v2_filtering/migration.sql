/*
  Warnings:

  - You are about to drop the column `periodId` on the `CommissionStatementEntry` table. All the data in the column will be lost.
  - Added the required column `uploadId` to the `CommissionStatementEntry` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "CommissionStatementEntry" DROP CONSTRAINT "CommissionStatementEntry_periodId_fkey";
-- DeleteExistingRows (dev only - clearing stale v1 test data, per instruction not to worry about existing data)
DELETE FROM "CommissionStatementEntry";
-- AlterTable
ALTER TABLE "CommissionStatementEntry" DROP COLUMN "periodId",
ADD COLUMN     "companyNameRaw" TEXT,
ADD COLUMN     "groupId" INTEGER,
ADD COLUMN     "statementPeriodEnd" DATE,
ADD COLUMN     "statementPeriodStart" DATE,
ADD COLUMN     "uploadId" INTEGER NOT NULL;

-- CreateTable
CREATE TABLE "CommissionStatementUpload" (
    "id" SERIAL NOT NULL,
    "sourceFile" TEXT NOT NULL,
    "carrierNameRaw" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'processed',

    CONSTRAINT "CommissionStatementUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationFilter" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "carrierNames" TEXT[],
    "productIds" INTEGER[],
    "groupIds" INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconciliationFilter_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CommissionStatementEntry" ADD CONSTRAINT "CommissionStatementEntry_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "CommissionStatementUpload"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionStatementEntry" ADD CONSTRAINT "CommissionStatementEntry_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;
