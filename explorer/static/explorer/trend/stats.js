/*
 * stats.js: client-side statistics for the Trend Analysis tab.
 * =============================================================
 * Pure functions with no DOM access, exposed as the global `TrendStats` (and as
 * module.exports when loaded by Node). Every result is meant to agree with the
 * server's reference engine (explorer/trend_engine.py: numpy, scipy and
 * statsmodels). explorer/test_trend_parity.py exports fixtures from Python, and
 * stats.selftest.html compares this file against them in the browser.
 *
 * Contents
 *   distributions: lgamma, regularized incomplete beta, Student-t / F / normal
 *                  CDFs and quantiles
 *   fit(x, y, opts): one segment by "ols" | "huber" | "theilsen" (same output
 *                  fields as trend_engine.SegmentResult)
 *   piecewise(x, y, breakpoints, opts): segments split the same way as
 *                  trend_engine.fit_piecewise_regression
 *   mannKendall, sensSlope, durbinWatson, acf, chowTest, detectBreaks
 *   bands: confidence band of the mean and prediction interval (also used for
 *                  projections beyond the data)
 *
 * Numerical note: x is centred on its mean before any sums are formed, and
 * slope/intercept are mapped back to calendar-year units at the end, so years
 * near 2000 never produce ill-conditioned normal equations.
 */
(function (root) {
  "use strict";

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------
  const sum = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
  const mean = a => sum(a) / a.length;
  function median(a) {
    const s = Float64Array.from(a).sort();
    const n = s.length, h = n >> 1;
    return n % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }
  // numpy.round: round half to even
  function roundHalfEven(v) {
    const r = Math.round(v);
    return (Math.abs(v % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r;
  }
  const isNum = v => typeof v === "number" && Number.isFinite(v);

  // ------------------------------------------------------------------
  // Special functions (Lanczos lgamma; Lentz continued fraction for I_x(a,b))
  // ------------------------------------------------------------------
  const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  function lgamma(z) {
    if (z < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * z))) - lgamma(1 - z);
    z -= 1;
    let x = LANCZOS[0];
    for (let i = 1; i < 9; i++) x += LANCZOS[i] / (z + i);
    const t = z + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }
  function betacf(a, b, x) {
    const MAXIT = 300, EPS = 1e-15, FPMIN = 1e-300;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }
  /** Regularized incomplete beta I_x(a, b). */
  function ibeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const lbt = lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x);
    if (x < (a + 1) / (a + b + 2)) return Math.exp(lbt) * betacf(a, b, x) / a;
    return 1 - Math.exp(lbt) * betacf(b, a, 1 - x) / b;
  }

  // ------------------------------------------------------------------
  // Distributions
  // ------------------------------------------------------------------
  /** Two-sided tail P(|T| > |t|) for Student-t with df degrees of freedom. */
  function tTwoSided(t, df) {
    if (!isNum(t)) return NaN;
    return ibeta(df / (df + t * t), df / 2, 0.5);
  }
  function tCdf(t, df) {
    const tail = 0.5 * tTwoSided(t, df);
    return t >= 0 ? 1 - tail : tail;
  }
  /** Student-t quantile by bisection, then Newton polish (needed for df < 1e6). */
  function tPpf(p, df) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    if (p === 0.5) return 0;
    let lo = -1e3, hi = 1e3;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (tCdf(mid, df) < p) lo = mid; else hi = mid;
      if (hi - lo < 1e-13 * Math.max(1, Math.abs(mid))) break;
    }
    return (lo + hi) / 2;
  }
  /** Upper tail P(F > f) for the F(d1, d2) distribution. */
  function fSf(f, d1, d2) {
    if (!(f > 0)) return 1;
    return ibeta(d2 / (d2 + d1 * f), d2 / 2, d1 / 2);
  }
  // erfc: Taylor series near 0, Lentz continued fraction elsewhere (~1e-15)
  function erfc(x) {
    const z = Math.abs(x);
    const r = z < 0.5 ? 1 - erfSeries(z) : erfcCF(z);
    return x >= 0 ? r : 2 - r;
  }
  function erfSeries(x) { // Taylor series, accurate for small |x|
    let s = x, term = x;
    const x2 = x * x;
    for (let n = 1; n < 60; n++) {
      term *= -x2 / n;
      const add = term / (2 * n + 1);
      s += add;
      if (Math.abs(add) < 1e-17 * Math.abs(s)) break;
    }
    return 2 / Math.sqrt(Math.PI) * s;
  }
  function erfcCF(x) { // Lentz continued fraction for erfc, x >= 0.5
    const FPMIN = 1e-300;
    let f = x, C = x, D = 0;
    for (let n = 1; n < 500; n++) {
      const an = n / 2;
      D = x + an * D; if (Math.abs(D) < FPMIN) D = FPMIN;
      C = x + an / C; if (Math.abs(C) < FPMIN) C = FPMIN;
      D = 1 / D;
      const del = C * D;
      f *= del;
      if (Math.abs(del - 1) < 1e-16) break;
    }
    return Math.exp(-x * x) / (f * Math.sqrt(Math.PI));
  }
  const normCdf = z => 0.5 * erfc(-z / Math.SQRT2);
  const normTwoSided = z => isNum(z) ? erfc(Math.abs(z) / Math.SQRT2) : NaN;
  /** Normal quantile (Acklam) with one Halley refinement step: ~1e-15. */
  function normPpf(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
      1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
      6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
      -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
      3.754408661907416e+00];
    let x;
    if (p < 0.02425) {
      const q = Math.sqrt(-2 * Math.log(p));
      x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    } else if (p <= 1 - 0.02425) {
      const q = p - 0.5, r = q * q;
      x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
        (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    } else {
      const q = Math.sqrt(-2 * Math.log(1 - p));
      x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    const e = normCdf(x) - p;
    const u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
    return x - u / (1 + x * u / 2);
  }

  // ------------------------------------------------------------------
  // Weighted least squares on centred x: returns params in ORIGINAL x units
  // ------------------------------------------------------------------
  function wls(x, y, w) {
    const n = x.length;
    let sw = 0, swx = 0, swy = 0;
    for (let i = 0; i < n; i++) { const wi = w ? w[i] : 1; sw += wi; swx += wi * x[i]; swy += wi * y[i]; }
    const xb = swx / sw, yb = swy / sw;
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      const wi = w ? w[i] : 1, dx = x[i] - xb;
      sxx += wi * dx * dx; sxy += wi * dx * (y[i] - yb);
    }
    const slope = sxx > 0 ? sxy / sxx : NaN;
    const intercept = yb - slope * xb;
    return { slope, intercept, xb, sxx, sw };
  }

  // ------------------------------------------------------------------
  // Huber M-estimation (statsmodels RLM: HuberT(t=1.345), MAD scale about 0,
  // IRLS, conv="dev", tol=1e-8, maxiter=50, cov="H1").
  // ------------------------------------------------------------------
  const HUBER_T = 1.345;
  const MAD_C = 0.6744897501960817; // norm.ppf(0.75)
  const madAbout0 = r => median(r.map(Math.abs)) / MAD_C;
  const huberRho = z => Math.abs(z) <= HUBER_T ? 0.5 * z * z : HUBER_T * Math.abs(z) - 0.5 * HUBER_T * HUBER_T;
  const huberPsi = z => Math.abs(z) <= HUBER_T ? z : HUBER_T * Math.sign(z);
  const huberPsiDeriv = z => Math.abs(z) <= HUBER_T ? 1 : 0;
  const huberW = z => Math.abs(z) <= HUBER_T ? 1 : HUBER_T / Math.abs(z);

  function huberFit(x, y) {
    // Mirrors statsmodels RLM.fit step for step, including its convergence
    // criterion: the deviance divides residuals by the WLS results' own
    // "scale" (weighted SSR / (n - 2)), not by the MAD scale.
    const n = x.length, MAXITER = 50, TOL = 1e-8;
    const resid = (p) => y.map((yi, i) => yi - (p.intercept + p.slope * x[i]));
    const deviance = (r, w) => {
      let s = 0; for (let i = 0; i < n; i++) s += (w ? w[i] : 1) * r[i] * r[i];
      const sc = s / (n - 2);
      return sum(r.map(ri => huberRho(ri / sc)));
    };
    let p = wls(x, y, null);
    let r = resid(p);
    let scale = madAbout0(r);
    const crit = [Infinity, deviance(r, null)];
    let it = 1;
    for (;;) {
      if (scale === 0) break;
      const w = r.map(ri => huberW(ri / scale));
      p = wls(x, y, w);
      r = resid(p);
      scale = madAbout0(r);
      crit.push(deviance(r, w));
      it++;
      if (!(Math.abs(crit[it] - crit[it - 1]) > TOL && it < MAXITER)) break;
    }
    // H1 covariance (Huber 1981), statsmodels RLMResults.bcov_scaled
    const sres = r.map(ri => ri / scale);
    const pd = sres.map(huberPsiDeriv);
    const m = mean(pd);
    const varPd = mean(pd.map(v => (v - m) * (v - m)));
    const k = 1 + 2 / n * varPd / (m * m);
    const ssPsi = sum(sres.map(z => huberPsi(z) ** 2));
    const factor = k * k * (ssPsi / (n - 2) * scale * scale) / ((sum(pd) / n) ** 2);
    // normalized_cov_params = inv(X'X) for the ORIGINAL (unweighted) design
    const xb = mean(x);
    let sxx = 0; for (const xi of x) sxx += (xi - xb) ** 2;
    const seSlope = Math.sqrt(factor / sxx);
    return { slope: p.slope, intercept: p.intercept, seSlope, scale };
  }

  // ------------------------------------------------------------------
  // Theil-Sen (scipy.stats.theilslopes, method="separate")
  // ------------------------------------------------------------------
  function repeatCounts(a) {
    const m = new Map();
    for (const v of a) m.set(v, (m.get(v) || 0) + 1);
    return [...m.values()].filter(c => c > 1);
  }
  function theilSen(x, y, confidence) {
    const n = x.length, slopes = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const dx = x[i] - x[j];
      if (dx > 0) slopes.push((y[i] - y[j]) / dx);
    }
    slopes.sort((a, b) => a - b);
    const nt = slopes.length;
    if (!nt) return { slope: NaN, intercept: NaN, lo: NaN, hi: NaN };
    const medSlope = median(slopes);
    const medInter = median(y) - medSlope * median(x);
    let alpha = confidence > 0.5 ? 1 - confidence : confidence;
    const z = normPpf(alpha / 2);
    const tie = c => c * (c - 1) * (2 * c + 5);
    const sigsq = (n * (n - 1) * (2 * n + 5) - sum(repeatCounts(x).map(tie)) - sum(repeatCounts(y).map(tie))) / 18;
    const sigma = Math.sqrt(sigsq);
    const Ru = Math.min(roundHalfEven((nt - z * sigma) / 2), nt - 1);
    const Rl = Math.max(roundHalfEven((nt + z * sigma) / 2) - 1, 0);
    return { slope: medSlope, intercept: medInter, lo: slopes[Rl], hi: slopes[Ru] };
  }

  // ------------------------------------------------------------------
  // One segment: same statistics suite as trend_engine._fit_single_segment
  // ------------------------------------------------------------------
  /**
   * @param {number[]} x  times (calendar years)
   * @param {number[]} y  values
   * @param {{method?: "ols"|"huber"|"theilsen", confidence?: number}} [opts]
   * @returns {object} slope, intercept, r2, adjR2, se, ci, t, p, rmse, ... plus helpers
   * @throws {Error} with a readable message for n < 2, NaN input or zero x-variance
   */
  function fit(x, y, opts) {
    opts = opts || {};
    const method = opts.method || "ols";
    const conf = opts.confidence || 0.95;
    const n = x.length;
    if (n !== y.length) throw new Error("x and y differ in length.");
    if (n < 2) throw new Error(`Only ${n} point(s) in range; at least 2 are needed.`);
    for (let i = 0; i < n; i++) if (!isNum(x[i]) || !isNum(y[i])) throw new Error("Series contains non-numeric values.");
    const base = wls(x, y, null);
    if (!(base.sxx > 0)) throw new Error("All points share the same year; a slope cannot be estimated.");

    const yb = mean(y);
    let sst = 0; for (const v of y) sst += (v - yb) ** 2;
    const dof = Math.max(n - 2, 1);

    // Flat segment (same rule as trend_engine._is_constant): exact slope 0,
    // undefined R² / SE / p rather than floating-point noise.
    const ymax = Math.max(...y), ymin = Math.min(...y);
    const constant = ymax - ymin <= 1e-12 * Math.max(1, Math.abs(ymax), Math.abs(ymin));

    let slope, intercept, se, tStat, pVal, warning = null;
    if (constant) {
      slope = 0; intercept = yb; se = NaN; tStat = NaN; pVal = NaN;
      warning = "All values are equal: the slope is 0 and R², the standard error and p are undefined.";
    } else if (method === "huber") {
      const h = huberFit(x, y);
      slope = h.slope; intercept = h.intercept; se = h.seSlope;
      // same threshold as trend_engine (relative to the data's magnitude)
      if (!(h.scale > 1e-10 * Math.max(1, ...y.map(Math.abs)))) {
        se = NaN;
        warning = "Huber scale is zero (over half the points lie exactly on the line): standard errors are undefined.";
      }
      tStat = slope / se; pVal = normTwoSided(tStat);
    } else if (method === "theilsen") {
      const ts = theilSen(x, y, conf);
      slope = ts.slope; intercept = ts.intercept;
      se = (ts.hi - ts.lo) / (2 * normPpf(0.5 + conf / 2));
      tStat = se > 0 ? slope / se : NaN;
      pVal = isNum(tStat) ? 2 * (1 - normCdf(Math.abs(tStat))) : NaN;
    } else {
      slope = base.slope; intercept = base.intercept;
      let ssr0 = 0; for (let i = 0; i < n; i++) ssr0 += (y[i] - intercept - slope * x[i]) ** 2;
      // statsmodels: s^2 = SSR / (n - 2); with n == 2 it divides by 0 -> inf / nan
      const s2 = n > 2 ? ssr0 / (n - 2) : NaN;
      se = Math.sqrt(s2 / base.sxx);
      tStat = slope / se;
      pVal = n > 2 ? tTwoSided(tStat, n - 2) : NaN;
    }

    const yhat = x.map(xi => intercept + slope * xi);
    const resid = constant ? y.map(() => 0) : y.map((yi, i) => yi - yhat[i]);
    let ssr = 0, sabs = 0;
    for (const r of resid) { ssr += r * r; sabs += Math.abs(r); }
    // OLS R^2 equals 1 - SSR/SST; other methods use the same manual formula as the engine.
    const r2 = !constant && sst > 0 ? 1 - ssr / sst : NaN;
    const adjR2 = n > 2 && isNum(r2) ? 1 - (1 - r2) * (n - 1) / dof : NaN;
    const tCrit = tPpf(0.5 + conf / 2, dof);
    const residVar = ssr / dof;

    return {
      method, confidence: conf, n, dof,
      start: Math.min(...x), end: Math.max(...x),
      slope, intercept,
      // level of the fitted line at the first year (more readable than the year-0 intercept)
      levelAtStart: intercept + slope * Math.min(...x),
      r2, adjR2,
      rmse: Math.sqrt(ssr / n), mae: sabs / n, mse: ssr / n,
      se, ciLow: slope - tCrit * se, ciHigh: slope + tCrit * se,
      t: tStat, p: pVal, residualVariance: residVar,
      sst, ssr,
      fStat: method === "ols" && n > 2 ? ((sst - ssr) / 1) / (ssr / (n - 2)) : NaN,
      x: x.slice(), y: y.slice(), yhat, resid,
      xMean: base.xb, sxx: base.sxx,
      dw: durbinWatson(resid),
      constant, warning,
    };
  }

  /**
   * Confidence band for the mean response and prediction interval for a new
   * observation at each xs (engine: prediction_band for the former).
   */
  function bands(seg, xs, confidence) {
    const conf = confidence || seg.confidence;
    const s = Math.sqrt(seg.residualVariance);
    const tCrit = tPpf(0.5 + conf / 2, Math.max(seg.n - 2, 1));
    return xs.map(xv => {
      const yv = seg.intercept + seg.slope * xv;
      const lev = 1 / seg.n + (seg.sxx > 0 ? (xv - seg.xMean) ** 2 / seg.sxx : 0);
      const hm = seg.sxx > 0 ? tCrit * s * Math.sqrt(lev) : 0;
      const hp = tCrit * s * Math.sqrt(1 + lev);
      return { x: xv, y: yv, meanLo: yv - hm, meanHi: yv + hm, predLo: yv - hp, predHi: yv + hp };
    });
  }

  // ------------------------------------------------------------------
  // Non-parametric trend tests
  // ------------------------------------------------------------------
  function mannKendall(y) {
    const n = y.length;
    let s = 0;
    for (let k = 0; k < n - 1; k++) for (let j = k + 1; j < n; j++) s += Math.sign(y[j] - y[k]);
    const tie = sum(repeatCounts(y).map(c => c * (c - 1) * (2 * c + 5)));
    const varS = (n * (n - 1) * (2 * n + 5) - tie) / 18;
    let z = 0;
    if (s > 0) z = varS > 0 ? (s - 1) / Math.sqrt(varS) : 0;
    else if (s < 0) z = varS > 0 ? (s + 1) / Math.sqrt(varS) : 0;
    const p = 2 * (1 - normCdf(Math.abs(z)));
    const tau = n > 1 ? s / (n * (n - 1) / 2) : NaN;
    const trend = (z > 0 && p < 0.05) ? "increasing" : (z < 0 && p < 0.05) ? "decreasing" : "no significant trend";
    return { S: s, varianceS: varS, Z: z, p, tau, trend };
  }
  function sensSlope(x, y, confidence) {
    const t = theilSen(x, y, confidence || 0.95);
    return { slope: t.slope, intercept: t.intercept, ciLow: t.lo, ciHigh: t.hi };
  }

  // ------------------------------------------------------------------
  // Residual diagnostics
  // ------------------------------------------------------------------
  function durbinWatson(r) {
    let num = 0, den = 0;
    for (let i = 0; i < r.length; i++) { den += r[i] * r[i]; if (i) num += (r[i] - r[i - 1]) ** 2; }
    return den > 0 ? num / den : NaN;
  }
  /** Sample autocorrelation for lags 0..maxLag (statsmodels acf, adjusted=False). */
  function acf(r, maxLag) {
    const n = r.length, m = mean(r);
    const d = r.map(v => v - m);
    const c0 = sum(d.map(v => v * v)) / n;
    const out = [];
    for (let k = 0; k <= Math.min(maxLag, n - 1); k++) {
      let c = 0; for (let i = k; i < n; i++) c += d[i] * d[i - k];
      out.push(c0 > 0 ? (c / n) / c0 : NaN);
    }
    return out;
  }
  /** Normal Q-Q pairs (Blom plotting positions). */
  function qq(r) {
    const s = Float64Array.from(r).sort(), n = s.length;
    return Array.from(s, (v, i) => ({ theoretical: normPpf((i + 1 - 0.375) / (n + 0.25)), sample: v }));
  }
  /** Jarque-Bera normality test of residuals. */
  function jarqueBera(r) {
    const n = r.length, m = mean(r);
    let m2 = 0, m3 = 0, m4 = 0;
    for (const v of r) { const d = v - m; m2 += d * d; m3 += d ** 3; m4 += d ** 4; }
    m2 /= n; m3 /= n; m4 /= n;
    const skew = m3 / Math.pow(m2, 1.5), kurt = m4 / (m2 * m2);
    const jb = n / 6 * (skew * skew + (kurt - 3) ** 2 / 4);
    return { JB: jb, p: Math.exp(-jb / 2), skew, kurtosis: kurt }; // chi2(2) survival = exp(-x/2)
  }

  // ------------------------------------------------------------------
  // Piecewise fits and structural breaks
  // ------------------------------------------------------------------
  const MIN_POINTS_PER_SEGMENT = 3;

  /** Split points exactly as fit_piecewise_regression: [lo, hi] then (lo, hi]. */
  function splitAt(x, breakpoints) {
    const lo0 = Math.min(...x), hi0 = Math.max(...x);
    const bps = [...new Set(breakpoints.filter(b => b > lo0 && b < hi0))].sort((a, b) => a - b);
    const edges = [lo0, ...bps, hi0];
    const parts = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const lo = edges[i], hi = edges[i + 1], idx = [];
      x.forEach((v, j) => { if ((i === 0 ? v >= lo : v > lo) && v <= hi) idx.push(j); });
      parts.push({ index: i + 1, lo, hi, idx });
    }
    return { parts, used: bps, dropped: breakpoints.filter(b => !bps.includes(b)) };
  }

  function piecewise(x, y, breakpoints, opts) {
    const { parts, used, dropped } = splitAt(x, breakpoints || []);
    const segments = [], skipped = [];
    for (const p of parts) {
      if (p.idx.length < MIN_POINTS_PER_SEGMENT) { skipped.push(p); continue; }
      const seg = fit(p.idx.map(i => x[i]), p.idx.map(i => y[i]), opts);
      seg.index = p.index;
      segments.push(seg);
    }
    if (!segments.length) throw new Error("No segment has the 3 points it needs. Move or remove breakpoints.");
    return { segments, used, dropped, skipped };
  }

  /**
   * Chow test for a break at `bp`: are the lines before and after it the same?
   * Uses the engine's split rule (left segment includes bp). k = 2 parameters.
   */
  function chowTest(x, y, bp) {
    const L = [], R = [];
    x.forEach((v, i) => (v <= bp ? L : R).push(i));
    if (L.length < 3 || R.length < 3) return null;
    const ssrOf = idx => fit(idx.map(i => x[i]), idx.map(i => y[i])).ssr;
    const pooled = fit(x, y).ssr, s1 = ssrOf(L), s2 = ssrOf(R);
    const k = 2, df2 = x.length - 2 * k;
    if (df2 <= 0) return null;
    const F = ((pooled - (s1 + s2)) / k) / ((s1 + s2) / df2);
    return { breakpoint: bp, F, df1: k, df2, p: fSf(F, k, df2) };
  }

  /**
   * Search for the breakpoint set (0..maxBreaks breaks) that minimises BIC of
   * an unconstrained piecewise OLS model (2 params per segment + 1 per break).
   * Exhaustive search: fine for annual series (< 100 points).
   */
  function detectBreaks(x, y, maxBreaks, minSeg) {
    maxBreaks = Math.min(maxBreaks == null ? 3 : maxBreaks, 4);
    minSeg = minSeg || 4;
    const n = x.length;
    const order = x.map((_, i) => i).sort((a, b) => x[a] - x[b]);
    const xs = order.map(i => x[i]), ys = order.map(i => y[i]);
    // pre-compute SSR for every contiguous run [i, j]
    const ssr = Array.from({ length: n }, () => new Float64Array(n).fill(Infinity));
    for (let i = 0; i < n; i++) for (let j = i + minSeg - 1; j < n; j++) {
      ssr[i][j] = fit(xs.slice(i, j + 1), ys.slice(i, j + 1)).ssr;
    }
    const bic = (s, m) => n * Math.log(Math.max(s, 1e-300) / n) + (3 * m + 2) * Math.log(n);
    let best = { breaks: [], ssr: ssr[0][n - 1], bic: bic(ssr[0][n - 1], 0) };
    const results = [best];
    // dynamic programming: cost[m][j] = min SSR of fitting [0..j] with m breaks
    let prev = Array.from({ length: n }, (_, j) => ({ c: ssr[0][j], path: [] }));
    for (let m = 1; m <= maxBreaks; m++) {
      const cur = Array.from({ length: n }, () => ({ c: Infinity, path: null }));
      for (let j = 0; j < n; j++) for (let b = 0; b < j; b++) {
        const c = prev[b].c + ssr[b + 1][j];
        if (c < cur[j].c) cur[j] = { c, path: [...prev[b].path, b] };
      }
      const end = cur[n - 1];
      if (isFinite(end.c)) {
        const cand = { breaks: end.path.map(i => xs[i]), ssr: end.c, bic: bic(end.c, m) };
        results.push(cand);
        if (cand.bic < best.bic) best = cand;
      }
      prev = cur;
    }
    return { best, candidates: results };
  }

  // ------------------------------------------------------------------
  // Descriptive helpers for a selected range
  // ------------------------------------------------------------------
  function rangeSummary(x, y) {
    const n = x.length;
    const first = y[0], last = y[n - 1], span = x[n - 1] - x[0];
    return {
      first, last, span,
      change: last - first,
      pctChange: first !== 0 ? (last / first - 1) * 100 : NaN,
      cagr: first > 0 && last > 0 && span > 0 ? (Math.pow(last / first, 1 / span) - 1) * 100 : NaN,
      mean: mean(y), min: Math.min(...y), max: Math.max(...y),
      sd: n > 1 ? Math.sqrt(sum(y.map(v => (v - mean(y)) ** 2)) / (n - 1)) : NaN,
    };
  }

  const api = {
    sum, mean, median, lgamma, ibeta,
    tCdf, tPpf, tTwoSided, fSf, normCdf, normPpf, normTwoSided,
    fit, bands, piecewise, splitAt, mannKendall, sensSlope, theilSen,
    durbinWatson, acf, qq, jarqueBera, chowTest, detectBreaks, rangeSummary,
    MIN_POINTS_PER_SEGMENT,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.TrendStats = api;
})(typeof window !== "undefined" ? window : globalThis);
