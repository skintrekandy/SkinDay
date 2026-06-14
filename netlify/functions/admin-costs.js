// netlify/functions/admin-costs.js
// Returns cost summary data for the admin dashboard.
// Protected by ADMIN_SECRET env var (Bearer token check).
// Returns JSON; called by admin-costs.html via fetch.

const { createClient } = require('@supabase/supabase-js');

// Credit pack definitions (mirror from visualize-generate.js)
const PACKS = [
  { id: 'starter', credits: 20,  price_cad: 29 },
  { id: 'clinic',  credits: 60,  price_cad: 69 },
  { id: 'studio',  credits: 150, price_cad: 139 },
];
// Exchange rate for display (USD cost vs CAD revenue)
const CAD_TO_USD = parseFloat(process.env.CAD_TO_USD || '0.73');

exports.handler = async (event) => {
  // Auth check
  const auth = (event.headers['authorization'] || '').replace('Bearer ', '').trim();
  if(!process.env.ADMIN_SECRET || auth !== process.env.ADMIN_SECRET){
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Daily summary (last 30 days)
    const { data: daily, error: dailyErr } = await supabase
      .from('generation_cost_summary')
      .select('*')
      .limit(30);
    if(dailyErr) throw dailyErr;

    // All-time totals
    const { data: totals, error: totalsErr } = await supabase
      .from('generation_logs')
      .select('estimated_cost_usd, credits_charged, status, treatment_type, angle')
      .gte('created_at', new Date(Date.now() - 30 * 86400_000).toISOString());
    if(totalsErr) throw totalsErr;

    // Compute aggregate stats
    const successful = totals.filter(r => r.status === 'success');
    const failed     = totals.filter(r => r.status !== 'success');
    const totalCostUsd    = totals.reduce((s, r) => s + (parseFloat(r.estimated_cost_usd) || 0), 0);
    const successCostUsd  = successful.reduce((s, r) => s + (parseFloat(r.estimated_cost_usd) || 0), 0);
    const wastedCostUsd   = failed.reduce((s, r) => s + (parseFloat(r.estimated_cost_usd) || 0), 0);
    const avgCostSuccess  = successful.length ? successCostUsd / successful.length : 0;
    const totalCredits    = successful.reduce((s, r) => s + (r.credits_charged || 0), 0);

    // Revenue estimate from credits (credits -> nearest pack -> CAD price)
    // Rough: assume 1 credit sold at effective rate of Clinic pack ($69/60cr = $1.15 CAD/cr)
    const effectiveRateCAD = 69 / 60;
    const revenueEstCAD    = totalCredits * effectiveRateCAD;
    const revenueEstUSD    = revenueEstCAD * CAD_TO_USD;
    const marginUSD        = revenueEstUSD - successCostUsd;

    // Pack margin analysis
    const packMargins = PACKS.map(p => {
      const revenueUsd    = p.price_cad * CAD_TO_USD;
      const costPerCredit = avgCostSuccess; // biostim = 2cr, filler = 1cr
      const costIfAllFiller  = p.credits * costPerCredit;
      const costIfAllBiostim = (p.credits / 2) * costPerCredit; // half as many gens
      return {
        pack:              p.id,
        credits:           p.credits,
        price_cad:         p.price_cad,
        revenue_usd:       revenueUsd,
        cost_if_all_filler:   costIfAllFiller,
        cost_if_all_biostim:  costIfAllBiostim,
        margin_if_all_filler:   revenueUsd - costIfAllFiller,
        margin_if_all_biostim:  revenueUsd - costIfAllBiostim,
      };
    });

    // By angle breakdown
    const byAngle = {};
    for(const r of successful){
      const a = r.angle || 'unknown';
      if(!byAngle[a]) byAngle[a] = { count: 0, cost: 0 };
      byAngle[a].count++;
      byAngle[a].cost += parseFloat(r.estimated_cost_usd) || 0;
    }

    // By treatment type
    const byType = {};
    for(const r of successful){
      const t = r.treatment_type || 'unknown';
      if(!byType[t]) byType[t] = { count: 0, cost: 0 };
      byType[t].count++;
      byType[t].cost += parseFloat(r.estimated_cost_usd) || 0;
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        window_days: 30,
        totals: {
          total_generations:  totals.length,
          successful:         successful.length,
          failed:             failed.length,
          total_cost_usd:     totalCostUsd,
          success_cost_usd:   successCostUsd,
          wasted_cost_usd:    wastedCostUsd,
          avg_cost_per_gen:   avgCostSuccess,
          total_credits_used: totalCredits,
          revenue_est_cad:    revenueEstCAD,
          revenue_est_usd:    revenueEstUSD,
          margin_est_usd:     marginUSD,
        },
        daily,
        by_angle:    byAngle,
        by_type:     byType,
        pack_margins: packMargins,
      }),
    };
  } catch(err){
    console.error('[admin-costs] Error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
