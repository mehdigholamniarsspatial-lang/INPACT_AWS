"""
Tests for the Trend Analysis engine and API used by the interactive tab.

* trend_engine against independent references: numpy.polyfit, closed-form
  OLS formulas and scipy's Theil-Sen, plus known-answer and edge cases.
* /api/trend/bundle/ (the data the browser engine works on).
* /api/trend/fit/ input validation and the start/end analysis window the
  browser uses for "Verify on server".

Browser/server agreement for every series is checked by
explorer/static/explorer/trend/stats.selftest.html (run it on a live server).
"""
import json
import math

import numpy as np
from django.test import SimpleTestCase, TestCase
from scipy import stats

from explorer import trend_engine as te
from explorer import trend_views as tv


class EngineReferenceTests(SimpleTestCase):
    def test_ols_matches_polyfit_on_every_series(self):
        _, table = tv._load_gas_table("Total GHG")
        checked = 0
        for sector in table:
            t, y, _ = tv._get_series("Total GHG", sector)
            if len(t) < 3 or np.ptp(y) == 0:
                continue
            seg = te.fit_piecewise_regression(t, y, [])[0]
            slope, intercept = np.polyfit(t, y, 1)
            self.assertAlmostEqual(seg.slope, slope, delta=1e-9 * max(1, abs(slope)), msg=sector)
            self.assertAlmostEqual(seg.intercept, intercept, delta=1e-7 * max(1, abs(intercept)), msg=sector)
            checked += 1
        self.assertGreater(checked, 10)

    def test_ols_statistics_match_closed_form(self):
        rng = np.random.default_rng(7)
        t = np.arange(1990.0, 2024.0)
        y = 500 - 3.2 * (t - 1990) + rng.normal(0, 4, t.size)
        seg = te.fit_piecewise_regression(t, y, [])[0]
        n = t.size
        b1, b0 = np.polyfit(t, y, 1)
        resid = y - (b0 + b1 * t)
        s2 = resid @ resid / (n - 2)
        se = math.sqrt(s2 / np.sum((t - t.mean()) ** 2))
        r2 = 1 - resid @ resid / np.sum((y - y.mean()) ** 2)
        tcrit = stats.t.ppf(0.975, n - 2)
        self.assertAlmostEqual(seg.std_error, se, places=9)
        self.assertAlmostEqual(seg.r_squared, r2, places=12)
        self.assertAlmostEqual(seg.p_value, 2 * stats.t.sf(abs(b1 / se), n - 2), places=12)
        self.assertAlmostEqual(seg.ci_low, b1 - tcrit * se, places=9)
        self.assertAlmostEqual(seg.ci_high, b1 + tcrit * se, places=9)

    def test_perfect_line_known_answer(self):
        t = np.arange(2000.0, 2010.0)
        seg = te.fit_piecewise_regression(t, 2.5 * t - 100, [])[0]
        self.assertAlmostEqual(seg.slope, 2.5, places=10)
        self.assertAlmostEqual(seg.r_squared, 1.0, places=12)
        self.assertLess(seg.rmse, 1e-8)

    def test_theilsen_matches_scipy(self):
        t = np.arange(2000.0, 2015.0)
        y = np.array([5, 7, 6, 9, 30, 11, 12, 11, 14, 15, 15, 17, 18, 19, 21], float)
        seg = te.fit_piecewise_regression(t, y, [], method="theilsen")[0]
        ref = stats.theilslopes(y, t)
        self.assertAlmostEqual(seg.slope, ref.slope, places=12)
        self.assertAlmostEqual(seg.intercept, ref.intercept, places=9)

    def test_huber_downweights_outlier(self):
        t = np.arange(2000.0, 2015.0)
        y = 100 - 2 * (t - 2000)
        y[13] += 80  # one gross outlier near the end (tilts OLS, not Huber)
        ols = te.fit_piecewise_regression(t, y, [], method="ols")[0]
        hub = te.fit_piecewise_regression(t, y, [], method="huber")[0]
        self.assertLess(abs(hub.slope + 2), abs(ols.slope + 2))

    def test_piecewise_split_rule(self):
        t = np.arange(1990.0, 2010.0)
        segs = te.fit_piecewise_regression(t, t * 0 + np.arange(20.0), [1999])
        self.assertEqual((segs[0].start, segs[0].end, segs[0].n), (1990, 1999, 10))
        self.assertEqual((segs[1].start, segs[1].end, segs[1].n), (2000, 2009, 10))

    def test_constant_segment_is_exact_and_flagged(self):
        t = np.arange(2000.0, 2012.0)
        seg = te.fit_piecewise_regression(t, np.full(t.size, 0.01), [])[0]
        self.assertEqual(seg.slope, 0.0)
        self.assertAlmostEqual(seg.intercept, 0.01)
        for v in (seg.r_squared, seg.std_error, seg.p_value):
            self.assertTrue(math.isnan(v))
        row = seg.as_table_row()  # JSON-safe: NaN -> None
        self.assertIsNone(row["R2"])
        self.assertIsNone(row["p_value"])

    def test_huber_with_zero_scale_reports_undefined_se(self):
        t = np.arange(2000.0, 2013.0)
        y = np.full(t.size, 0.19)
        y[-1] = 0.0  # 12 equal values and one outlier: MAD scale collapses
        seg = te.fit_piecewise_regression(t, y, [], method="huber")[0]
        self.assertTrue(math.isnan(seg.std_error))
        self.assertTrue(math.isnan(seg.p_value))

    def test_too_few_points_per_segment(self):
        with self.assertRaises(ValueError):
            te.fit_piecewise_regression(np.array([2000.0, 2001.0]), np.array([1.0, 2.0]), [])

    def test_mann_kendall_known_values(self):
        mk = te.mann_kendall_test(np.arange(10.0))
        self.assertEqual(mk["S"], 45)
        self.assertEqual(mk["trend"], "increasing")
        mk = te.mann_kendall_test(np.array([1.0, 1, 1, 1, 1]))
        self.assertEqual(mk["S"], 0)
        self.assertEqual(mk["trend"], "no significant trend")


class TrendApiTests(TestCase):
    def _fit(self, **body):
        base = {"gas": "Total GHG", "sector": "Energy Industries", "method": "ols"}
        return self.client.post("/api/trend/fit/", data=json.dumps({**base, **body}),
                                content_type="application/json")

    def test_bundle_has_every_gas_and_aligned_series(self):
        body = self.client.get("/api/trend/bundle/").json()
        self.assertTrue(body["ok"])
        self.assertEqual(set(body["gases"]), set(tv._GAS_FILES))
        n = len(body["years"])
        for sectors in body["gases"].values():
            for values in sectors.values():
                self.assertEqual(len(values), n)

    def test_window_restricts_fit(self):
        body = self._fit(start=2010, end=2020).json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["years"][0], 2010)
        self.assertEqual(body["years"][-1], 2020)
        self.assertEqual(body["segments"][0]["N"], 11)
        t, y, _ = tv._get_series("Total GHG", "Energy Industries")
        m = (t >= 2010) & (t <= 2020)
        slope = np.polyfit(t[m], y[m], 1)[0]
        self.assertAlmostEqual(body["segments"][0]["Slope"], slope, places=5)

    def test_invalid_window(self):
        for body in ({"start": 2020, "end": 2010}, {"start": "2010"}, {"end": True},
                     {"start": 1500}, {"end": 1e9}):
            with self.subTest(body=body):
                self.assertEqual(self._fit(**body).status_code, 400)

    def test_window_with_too_few_points(self):
        r = self._fit(start=2020, end=2021)
        self.assertEqual(r.status_code, 422)
        self.assertIn("Too few valid data points", r.json()["detail"])

    def test_invalid_breakpoints(self):
        for bps in ("2005", [2005, "x"], [True], list(range(1991, 2003))):
            with self.subTest(bps=bps):
                self.assertEqual(self._fit(breakpoints=bps).status_code, 400)

    def test_nan_breakpoint_rejected(self):
        r = self.client.post("/api/trend/fit/", data='{"gas":"Total GHG","sector":"Energy Industries",'
                             '"breakpoints":[NaN]}', content_type="application/json")
        self.assertEqual(r.status_code, 400)

    def test_unknown_method_and_confidence(self):
        self.assertEqual(self._fit(method="lasso").status_code, 400)
        self.assertEqual(self._fit(confidence=1.5).status_code, 400)

    def test_unknown_series(self):
        self.assertEqual(self._fit(sector="Nope").status_code, 404)


class TrendPoliciesApiTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        # the test database starts empty; load the Policy Timeline release as its tests do
        from django.core.management import call_command
        call_command("load_policy_data", verbosity=0)

    def test_policy_lists_and_sector_mapping(self):
        body = self.client.get("/api/trend/policies/").json()
        self.assertTrue(body["ok"])
        self.assertGreater(len(body["core"]), 10)
        self.assertTrue(all({"year", "name", "level"} <= set(p) for p in body["core"]))
        self.assertGreater(len(body["sector"]), 10)
        for p in body["sector"]:
            self.assertTrue(p["slug"] and p["sector"] and isinstance(p["gases"], list))
            self.assertIn(p["sector"], body["sectors"])
        # residual aggregates are not offered as policies
        self.assertFalse(any(p["slug"].startswith("res-") for p in body["sector"]))
        m = body["sector_map"]
        self.assertEqual(m["Energy Industries"], "Electricity")
        self.assertEqual(m["Road transportation"], "Transport")
        self.assertEqual(m["Enteric fermentation"], "Agriculture")
        self.assertEqual(m["Residential"], "Buildings")
        self.assertIsNone(m["Other"])
        # every inventory sector of the trend data is in the map
        self.assertEqual(set(m), set(tv._load_gas_table("Total GHG")[1]))

    def test_policy_sector_rules(self):
        self.assertEqual(tv.policy_sector_for("Non-energy products from fuels and solvent use"), "Industry")
        self.assertEqual(tv.policy_sector_for("Wastewater treatment and discharge"), "Waste")
        self.assertIsNone(tv.policy_sector_for("Fugitive emissions"))
