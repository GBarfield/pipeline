-- CreateTable
CREATE TABLE "CommissionPeriod" (
    "id" SERIAL NOT NULL,
    "groupId" INTEGER NOT NULL,
    "periodMonth" DATE NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CensusEntry" (
    "id" SERIAL NOT NULL,
    "periodId" INTEGER NOT NULL,
    "sourceFile" TEXT NOT NULL,
    "employeeName" TEXT NOT NULL,
    "carrierName" TEXT NOT NULL,
    "productId" INTEGER,
    "productLabel" TEXT,
    "planName" TEXT,
    "coverageTier" TEXT,
    "premium" DECIMAL(10,2) NOT NULL,
    "rawRow" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CensusEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionStatementEntry" (
    "id" SERIAL NOT NULL,
    "periodId" INTEGER NOT NULL,
    "sourceFile" TEXT NOT NULL,
    "carrierName" TEXT NOT NULL,
    "productId" INTEGER,
    "productLabel" TEXT,
    "reportedPremium" DECIMAL(10,2) NOT NULL,
    "commissionAmount" DECIMAL(10,2),
    "rawRow" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionStatementEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommissionPeriod_groupId_periodMonth_key" ON "CommissionPeriod"("groupId", "periodMonth");

-- AddForeignKey
ALTER TABLE "CommissionPeriod" ADD CONSTRAINT "CommissionPeriod_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CensusEntry" ADD CONSTRAINT "CensusEntry_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "CommissionPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CensusEntry" ADD CONSTRAINT "CensusEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionStatementEntry" ADD CONSTRAINT "CommissionStatementEntry_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "CommissionPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionStatementEntry" ADD CONSTRAINT "CommissionStatementEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
