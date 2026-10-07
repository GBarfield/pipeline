-- CreateTable
CREATE TABLE "Quote" (
    "id" SERIAL NOT NULL,
    "groupId" INTEGER NOT NULL,
    "carrierName" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "usedDiscovery" BOOLEAN NOT NULL DEFAULT false,
    "rawData" JSONB NOT NULL,
    "xlsxPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "warnings" JSONB,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
