-- CreateTable
CREATE TABLE "Carrier" (
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
CREATE TABLE "Broker" (
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
CREATE TABLE "CarrierProduct" (
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
CREATE TABLE "Group" (
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

-- CreateIndex
CREATE UNIQUE INDEX "Broker_email_key" ON "Broker"("email");

-- AddForeignKey
ALTER TABLE "Broker" ADD CONSTRAINT "Broker_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarrierProduct" ADD CONSTRAINT "CarrierProduct_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
