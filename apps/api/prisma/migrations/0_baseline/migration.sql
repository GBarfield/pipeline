-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "public"."Broker" (
    "id" SERIAL NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "address" TEXT,
    "address2" TEXT,
    "city" TEXT,
    "state" VARCHAR(2),
    "zip" TEXT,
    "phone" TEXT,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "brokerType" TEXT,
    "image" TEXT,
    "isHouseAccount" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "loginSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "carrierId" INTEGER,

    CONSTRAINT "Broker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Carrier" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "contactFirstName" TEXT,
    "contactLastName" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" VARCHAR(2),
    "zip" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "specialty" TEXT,
    "logoImage" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Carrier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CarrierProduct" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "productType" TEXT,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "carrierId" INTEGER NOT NULL,

    CONSTRAINT "CarrierProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ComparisonRowMapping" (
    "id" SERIAL NOT NULL,
    "dealId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "section" TEXT NOT NULL,
    "canonicalLabel" TEXT NOT NULL,
    "aliasLabel" TEXT NOT NULL,
    "confirmedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComparisonRowMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Deal" (
    "id" SERIAL NOT NULL,
    "groupId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "effectiveDate" DATE,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Group" (
    "id" SERIAL NOT NULL,
    "company" TEXT NOT NULL,
    "contactFirstName" TEXT,
    "contactLastName" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" VARCHAR(2),
    "zip" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "effectiveDate" DATE,
    "shortCode" TEXT,
    "logoFile" TEXT,
    "industry" TEXT,
    "sicCode" TEXT,
    "signatureType" TEXT,
    "baseApp" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "isIHQ" BOOLEAN NOT NULL DEFAULT false,
    "hasPortal" BOOLEAN NOT NULL DEFAULT false,
    "emailText" TEXT,
    "zipFile" TEXT,
    "completedApps" INTEGER DEFAULT 0,
    "zipDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "brokerId" INTEGER,
    "carrierId" INTEGER,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."HealthCheck" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Product" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Quote" (
    "id" SERIAL NOT NULL,
    "carrierName" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "usedDiscovery" BOOLEAN NOT NULL DEFAULT false,
    "rawData" JSONB NOT NULL,
    "xlsxPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "warnings" JSONB,
    "productId" INTEGER,
    "source" TEXT NOT NULL,
    "dealId" INTEGER NOT NULL,
    "originalPdfPath" TEXT,
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "productLabel" TEXT,
    "supplement" JSONB,
    "planSelection" JSONB,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."QuoteCorrection" (
    "id" SERIAL NOT NULL,
    "quoteId" INTEGER NOT NULL,
    "previousQuoteId" INTEGER,
    "field" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Broker_email_key" ON "public"."Broker"("email" ASC);

-- CreateIndex
CREATE INDEX "ComparisonRowMapping_dealId_productId_idx" ON "public"."ComparisonRowMapping"("dealId" ASC, "productId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ComparisonRowMapping_dealId_productId_section_aliasLabel_key" ON "public"."ComparisonRowMapping"("dealId" ASC, "productId" ASC, "section" ASC, "aliasLabel" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Product_name_key" ON "public"."Product"("name" ASC);

-- AddForeignKey
ALTER TABLE "public"."Broker" ADD CONSTRAINT "Broker_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "public"."Carrier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierProduct" ADD CONSTRAINT "CarrierProduct_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "public"."Carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ComparisonRowMapping" ADD CONSTRAINT "ComparisonRowMapping_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "public"."Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ComparisonRowMapping" ADD CONSTRAINT "ComparisonRowMapping_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Deal" ADD CONSTRAINT "Deal_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "public"."Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Group" ADD CONSTRAINT "Group_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "public"."Broker"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Group" ADD CONSTRAINT "Group_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "public"."Carrier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Quote" ADD CONSTRAINT "Quote_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "public"."Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Quote" ADD CONSTRAINT "Quote_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."QuoteCorrection" ADD CONSTRAINT "QuoteCorrection_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "public"."Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
