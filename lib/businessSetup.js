/**
 * Onboarding status, computed from the business's real data (never stored as a flag that can drift).
 * Steps: 1 country and regions, 2 vehicle categories, 3 pricing, 4 confirm. Only "confirm" is an explicit action.
 */
function computeSetup({ market, regions, categories, fareRules, completedAt }) {
  const activeRegions = regions.filter((r) => r.active);
  const activeCategories = categories.filter((c) => c.active);
  const activeCategoryIds = new Set(activeCategories.map((c) => c.categoryId));
  const priced = fareRules.filter((f) => f.active && activeCategoryIds.has(f.categoryId));

  const stepDone = {
    regions: !!market && activeRegions.length > 0,
    categories: activeCategories.length > 0,
    pricing: priced.length > 0
  };
  const steps = [
    { key: 'regions', title: 'Country and service regions', path: '/regions', done: stepDone.regions },
    { key: 'categories', title: 'Vehicle categories', path: '/categories', done: stepDone.categories },
    { key: 'pricing', title: 'Pricing and fare rules', path: '/pricing', done: stepDone.pricing },
    { key: 'confirm', title: 'Confirm setup', path: '/', done: !!completedAt }
  ];
  const next = steps.find((s) => !s.done) || null;

  const warnings = [];
  if (market) {
    for (const c of activeCategories) {
      const cRegions = (c.regionIds || []).filter((id) => activeRegions.some((r) => r.regionId === id));
      if (cRegions.length === 0) {
        warnings.push({ code: 'category_no_active_region', message: `"${c.name}" is not available in any active region`, path: '/categories' });
        continue;
      }
      const hasDefault = fareRules.some((f) => f.active && f.categoryId === c.categoryId && f.regionId === null);
      if (!hasDefault) {
        const missing = cRegions.filter((id) => !fareRules.some((f) => f.active && f.categoryId === c.categoryId && f.regionId === id));
        if (missing.length === cRegions.length) {
          warnings.push({ code: 'category_unpriced', message: `"${c.name}" has no pricing yet`, path: '/pricing' });
        } else if (missing.length > 0) {
          const names = missing.map((id) => activeRegions.find((r) => r.regionId === id)).filter(Boolean).map((r) => `${r.city} (${r.zoneName})`);
          warnings.push({ code: 'category_partly_priced', message: `"${c.name}" has no pricing for ${names.join(', ')}`, path: '/pricing' });
        }
      }
    }
  }
  if (completedAt && next && next.key !== 'confirm') {
    warnings.push({ code: 'setup_regressed', message: 'Setup was confirmed earlier, but a required step is incomplete again', path: next.path });
  }

  const done = steps.filter((s) => s.done).length;
  return {
    steps,
    nextStep: next,
    percent: Math.round((done / steps.length) * 100),
    ready: stepDone.regions && stepDone.categories && stepDone.pricing, // steps 1-3 satisfied; may confirm
    complete: !!completedAt && stepDone.regions && stepDone.categories && stepDone.pricing,
    warnings
  };
}

module.exports = { computeSetup };
