-- Online fee payment through Paystack checkout. See the PaystackTransaction
-- model comment in schema.prisma for why a checkout attempt is its own table
-- rather than a PENDING Payment row. ALTER TYPE ... ADD VALUE is
-- transactional as of Postgres 12, and nothing in this migration uses the
-- new PAYSTACK value, so it is safe alongside the other statements.

-- CreateEnum
CREATE TYPE "PaystackTransactionStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'PAYSTACK';

-- CreateTable
CREATE TABLE "PaystackTransaction" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "feeObligationId" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "initiatedByUserId" TEXT NOT NULL,
    "status" "PaystackTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "authorizationUrl" TEXT,
    "paymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaystackTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaystackTransaction_reference_key" ON "PaystackTransaction"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "PaystackTransaction_paymentId_key" ON "PaystackTransaction"("paymentId");

-- CreateIndex
CREATE INDEX "PaystackTransaction_feeObligationId_status_idx" ON "PaystackTransaction"("feeObligationId", "status");

-- AddForeignKey
ALTER TABLE "PaystackTransaction" ADD CONSTRAINT "PaystackTransaction_feeObligationId_fkey" FOREIGN KEY ("feeObligationId") REFERENCES "FeeObligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaystackTransaction" ADD CONSTRAINT "PaystackTransaction_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

