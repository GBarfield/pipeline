-- CreateEnum
CREATE TYPE "PartnerType" AS ENUM ('CARRIER', 'TPA', 'VENDOR');

-- AlterTable
ALTER TABLE "Carrier" ADD COLUMN     "partnerType" "PartnerType" NOT NULL DEFAULT 'CARRIER';

-- CreateIndex
CREATE INDEX "Carrier_partnerType_idx" ON "Carrier"("partnerType");
