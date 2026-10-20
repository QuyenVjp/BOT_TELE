import { describe, expect, it } from "vitest";
import {
  presentAdminRefundAdjustPrompt,
  presentAdminRefundConfirm,
  presentAdminRefundPaidConfirm,
  presentAdminRefundPayout,
  presentAdminWarrantyClaim,
  type AdminClaimView,
} from "../../src/bot/presenters/warranty-admin.js";

const claim: AdminClaimView = {
  id: "01J00000000000000000000001",
  version: 7,
  claimNumber: "BH-2026-0001",
  status: "REFUND_DUE",
  statusLabel: "Chờ chuyển tiền",
  customerLabel: "Khách 0001",
  orderNumber: "ORD-2026-0001",
  productName: "ChatGPT Plus",
  issueType: "ACCOUNT_LOCKED",
  reportedAt: "2026-09-01T02:00:00.000Z",
  warrantyStart: "2026-09-01T02:00:00.000Z",
  warrantyEnd: "2026-10-01T02:00:00.000Z",
  usedDays: 1,
  remainingDays: 29,
  paidAmountVnd: 100000n,
  calculatedRefundVnd: 96666n,
  approvedRefundVnd: 96666n,
  assetRef: "#ASSET001",
  coverageSnapshot: "Lỗi tài khoản",
  exclusionsSnapshot: null,
  bankName: "Vietcombank",
  accountNumber: "0123456789",
  accountHolder: "NGUYEN VAN A",
  rejectionReason: null,
  timeline: [],
  canVerify: true,
  canReplace: true,
  canRefund: true,
};

describe("admin warranty expected-version callbacks", () => {
  it("carries the rendered claim version through every mutation screen", () => {
    const claimCallbacks = presentAdminWarrantyClaim(claim)
      .buttons.flat()
      .map((b) => b.callbackData);
    expect(claimCallbacks).toEqual(
      expect.arrayContaining([
        `admin:warranty:verify:${claim.id}:7`,
        `admin:warranty:info:${claim.id}:7`,
        `admin:warranty:reject:${claim.id}:7`,
        `admin:warranty:replace:${claim.id}:7`,
        `admin:warranty:refund:${claim.id}:7`,
        `admin:warranty:payout:${claim.id}:7`,
      ]),
    );

    const confirmCallbacks = presentAdminRefundConfirm({
      claimId: claim.id,
      expectedVersion: claim.version,
      claimNumber: claim.claimNumber,
      paidAmountVnd: claim.paidAmountVnd,
      warrantyDays: 30,
      usedDays: claim.usedDays,
      remainingDays: claim.remainingDays,
      recommendedVnd: claim.calculatedRefundVnd,
      accountNumber: claim.accountNumber,
    })
      .buttons.flat()
      .map((b) => b.callbackData);
    expect(confirmCallbacks).toContain(`admin:warranty:refund-confirm:${claim.id}:7`);
    expect(confirmCallbacks).toContain(`admin:warranty:refund-adjust:${claim.id}:7`);

    expect(
      presentAdminRefundAdjustPrompt({
        claimId: claim.id,
        expectedVersion: claim.version,
        recommendedVnd: claim.calculatedRefundVnd,
      })
        .buttons.flat()
        .map((b) => b.callbackData),
    ).toContain(`admin:warranty:refund:${claim.id}:7`);

    expect(
      presentAdminRefundPayout({
        claimId: claim.id,
        expectedVersion: claim.version,
        claimNumber: claim.claimNumber,
        customerLabel: claim.customerLabel,
        productName: claim.productName,
        amountVnd: claim.approvedRefundVnd!,
        reason: "Bảo hành",
        bankName: claim.bankName,
        accountNumber: claim.accountNumber,
        accountHolder: claim.accountHolder,
      })
        .buttons.flat()
        .map((b) => b.callbackData),
    ).toContain(`admin:warranty:paid:${claim.id}:7`);

    expect(
      presentAdminRefundPaidConfirm({
        claimId: claim.id,
        expectedVersion: claim.version,
        claimNumber: claim.claimNumber,
        amountVnd: claim.approvedRefundVnd!,
      })
        .buttons.flat()
        .map((b) => b.callbackData),
    ).toContain(`admin:warranty:paid-confirm:${claim.id}:7`);
  });
});
