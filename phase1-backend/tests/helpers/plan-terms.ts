/**
 * Phase 30 — what the owner does when he changes a plan's limits AND wants every
 * current subscriber on the new terms: publish a version, then renew them.
 *
 * Since plan versions, writing `plan_features` changes only what the plan SELLS
 * from now on; a merchant already subscribed keeps the version he subscribed
 * under. Suites that clamp a limit to test the refusal (md1, 20B-1, 20B-3) are
 * not testing versioning, so after editing plan_features they call this to make
 * the edit take effect for the subscribers on that plan — the same outcome as
 * the owner publishing and re-assigning, without routing every suite through
 * the owner's session. Versioning itself is proven by phase17 and review-fixes.
 */
export async function applyPlanTermsNow(prisma: any, planId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `WITH next AS (
       INSERT INTO plan_versions (plan_id, version, monthly_price_iqd, commission_bps, limits)
       SELECT p.id,
              COALESCE((SELECT max(v.version) FROM plan_versions v WHERE v.plan_id = p.id), 0) + 1,
              p.monthly_price_iqd, p.commission_bps,
              COALESCE((SELECT jsonb_object_agg(f.feature_code, f.limit_value) FROM plan_features f WHERE f.plan_id = p.id), '{}'::jsonb)
         FROM plans p WHERE p.id = $1::uuid
       RETURNING id
     )
     UPDATE merchant_subscriptions SET plan_version_id = (SELECT id FROM next)
      WHERE plan_id = $1::uuid AND status = 'active'`,
    planId
  );
}
