// Normalize a USDA FoodData Central food object (search or detail payload)
// into a lean Caly AI Food catalog doc (per 100g).
// FDC nutrient ids: 1008 kcal, 1003 protein, 1005 carbs, 1004 fat, 1079 fiber, 269 sugar.
// Search payloads use {nutrientId, value}; detail payloads use {nutrient:{id}, amount}.

function pickValue(nutrients, ids) {
  for (const n of nutrients || []) {
    // Search payload: {nutrientId, value}. Detail payload: {nutrient:{id|number}, amount}.
    // NOTE: detail `number` is a string ("208"), so coerce before comparing.
    const raw = n.nutrientId ?? n?.nutrient?.id ?? n?.nutrient?.number ?? n?.nutrient?.nutrientId;
    const id = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (ids.includes(id)) {
      const v = n.value ?? n.amount;
      if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 100) / 100;
    }
  }
  return null;
}

function normalizeFdcFood(f) {
  if (!f || typeof f.fdcId !== 'number') return null;
  const nutrients = f.foodNutrients || [];
  // 1008/1003/1005/1004/1079 = search ids; 208/203/205/204/291 = detail ids; 269 sugar both.
  const kcal = pickValue(nutrients, [1008, 208]);
  if (kcal == null) return null; // calorie tracker needs calories
  const description = (f.description || '').trim();
  if (!description) return null;
  return {
    fdcId: f.fdcId,
    name: description.length > 200 ? description.slice(0, 200) : description,
    dataType: f.dataType || 'Foundation',
    kcal,
    protein: pickValue(nutrients, [1003, 203]) ?? 0,
    carbs: pickValue(nutrients, [1005, 205]) ?? 0,
    fat: pickValue(nutrients, [1004, 204]) ?? 0,
    fiber: pickValue(nutrients, [1079, 291]) ?? 0,
    sugar: pickValue(nutrients, [269]) ?? 0,
    servingGram: 100,
    servingUnit: 'g',
    brand: f.brandOwner || null,
    gtinUpc: f.gtinUpc || null,
    imageUrl: null, // FDC provides no images — fill from OFF/cloud later
    source: 'FDC',
  };
}

module.exports = { normalizeFdcFood };
