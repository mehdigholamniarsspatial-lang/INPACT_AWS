"""
Views for the Ireland GHG Policy Impact Explorer.

The page is a single, self-contained HTML file (it inlines its own CSS and JS).
We read it from disk and return it verbatim, which deliberately bypasses
Django's template engine so the page's CSS/JS braces are never misinterpreted.

The one thing we inject is the emissions dataset: it is read from the editable
CSV at ``data/ghg_inventory.csv`` and spliced into two placeholders in the page
(``/*@INVENTORY@*/{}`` and ``/*@YEARS@*/[]``). Edit that CSV and reload the page
— the chart, indicator switcher and KPIs all recompute.
"""
import csv
import hmac
import io
import json
import os
import time
import zipfile
import logging
from pathlib import Path

from django.core import signing
from django.http import HttpResponse, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from . import feedback_store, feedback_survey
from . import edgar, inverse, mapeire
from . import timeseries
from . import overlays
from . import map_export as map_export_mod

logger = logging.getLogger(__name__)

# explorer/views.py -> explorer -> <project root>
BASE_DIR = Path(__file__).resolve().parent.parent
_PAGE_PATH = Path(__file__).resolve().parent / "page" / "index.html"
_PALETTES_PATH = Path(__file__).resolve().parent / "palettes.json"
_CSV_PATH = BASE_DIR / "data" / "ghg_inventory.csv"
_POLICIES_PATH = BASE_DIR / "data" / "policies.csv"

# Sectoral inventory (Main Sector -> Subsector time series), one wide CSV per gas.
# Each file: first column = sector/subsector name, remaining columns = years.
_SECTOR_DIR = BASE_DIR / "data" / "sector_inventory"
_SECTOR_FILES = {
    "Total GHG": "Total.csv",
    "CO₂": "CO2.csv",
    "CH₄": "CH4.csv",
    "N₂O": "N2O.csv",
}
# Normalise known typos / stray whitespace in the source spreadsheets so the
# row names match the hierarchy used by the page's Sector Explorer.
_SECTOR_NAME_FIXES = {
    "nann-energy products from fuels and solvent use":
        "Non-energy products from fuels and solvent use",
}


def _load_inventory(csv_path: Path):
    """
    Read the wide-format inventory CSV into the structure the page expects.

    Returns ``(real_data, years)`` where:
      * ``real_data`` maps each gas column header -> list of values (floats,
        or ``None`` for blank cells), aligned to ``years``.
      * ``years`` is the sorted list of integer years (the first CSV column).

    The gas column headers must match the keys used by the page's INDICATORS
    map (e.g. "All greenhouse gases", "CO2", "CH4 - (CO2 equivalent)", ...).
    """
    with csv_path.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.reader(fh)
        header = next(reader)
        # First column is the year; everything after is a gas series.
        gas_cols = [h.strip() for h in header[1:]]
        rows = []
        for raw in reader:
            if not raw or all(cell.strip() == "" for cell in raw):
                continue  # skip blank lines
            if raw[0].strip().startswith("#"):
                continue  # allow comment rows
            year = int(float(raw[0].strip()))
            values = []
            for cell in raw[1:]:
                cell = cell.strip()
                values.append(None if cell == "" else float(cell))
            # pad short rows so every gas stays aligned
            while len(values) < len(gas_cols):
                values.append(None)
            rows.append((year, values))

    rows.sort(key=lambda r: r[0])  # ascending years; arrays stay aligned
    years = [year for year, _ in rows]
    real_data = {
        gas: [vals[i] for _, vals in rows]
        for i, gas in enumerate(gas_cols)
    }
    return real_data, years


def _load_sector_inventory():
    """
    Read the per-gas sectoral CSVs into the structure the Sector Explorer expects.

    Returns ``(sector_data, years)`` where:
      * ``sector_data`` maps gas label -> { sector/subsector name -> [values] },
        values in kt CO2-eq (``None`` for blank/dash cells), aligned to ``years``.
      * ``years`` is the list of integer years taken from the CSV headers
        (all four files must share the same year columns).

    Raises ``FileNotFoundError`` if any of the four CSVs is missing, so the
    caller can fall back to an empty dataset.
    """
    def _cell(raw):
        cell = raw.strip().replace(",", "")
        if cell in ("", "-", "–", "NA", "NaN"):
            return None
        return float(cell)

    sector_data, years = {}, None
    for gas, fname in _SECTOR_FILES.items():
        path = _SECTOR_DIR / fname
        with path.open(newline="", encoding="utf-8-sig") as fh:
            reader = csv.reader(fh)
            header = next(reader)
            file_years = [int(float(h.strip())) for h in header[1:]]
            if years is None:
                years = file_years
            elif file_years != years:
                raise ValueError(f"{fname}: year columns differ from the other sector CSVs")

            table = {}
            for raw in reader:
                if not raw or all(c.strip() == "" for c in raw):
                    continue
                name = raw[0].strip()
                if not name or name.startswith("#"):
                    continue
                name = _SECTOR_NAME_FIXES.get(name, name)
                values = [_cell(c) for c in raw[1:]]
                while len(values) < len(years):
                    values.append(None)
                table[name] = values
            sector_data[gas] = table
    return sector_data, years


def _load_policies(csv_path: Path):
    """
    Read the climate-policy timeline CSV into a list of dicts.

    Expected columns: year, name, level, agency, sector, type, instrument,
    description, direction, outcome. ``level`` is one of International / EU /
    National / Target and drives the colour and the sidebar checkboxes.
    """
    policies = []
    with csv_path.open(newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            year_raw = (row.get("year") or "").strip()
            if not year_raw or year_raw.startswith("#"):
                continue
            policy = {k: (v or "").strip() for k, v in row.items()}
            policy["year"] = int(float(year_raw))
            policies.append(policy)
    policies.sort(key=lambda p: p["year"])
    return policies


def _render_page():
    """Read the page and splice in the inventory data from the CSV."""
    html = _PAGE_PATH.read_text(encoding="utf-8")
    try:
        real_data, years = _load_inventory(_CSV_PATH)
        inventory_json = json.dumps(real_data, ensure_ascii=False)
        years_json = json.dumps(years)
    except FileNotFoundError:
        # No dataset present: serve the page with an empty (but valid) dataset.
        inventory_json, years_json = "{}", "[]"

    try:
        policies_json = json.dumps(_load_policies(_POLICIES_PATH), ensure_ascii=False)
    except FileNotFoundError:
        policies_json = "[]"

    try:
        sector_data, sector_years = _load_sector_inventory()
        sectors_json = json.dumps(sector_data, ensure_ascii=False)
        sector_years_json = json.dumps(sector_years)
    except (FileNotFoundError, ValueError):
        # Missing/inconsistent sector CSVs: page falls back to inventory mode only.
        sectors_json, sector_years_json = "{}", "[]"

    html = html.replace("/*@INVENTORY@*/{}", inventory_json, 1)
    html = html.replace("/*@YEARS@*/[]", years_json, 1)
    html = html.replace("/*@POLICIES@*/[]", policies_json, 1)
    html = html.replace("/*@SECTORS@*/{}", sectors_json, 1)
    html = html.replace("/*@SECTOR_YEARS@*/[]", sector_years_json, 1)
    # Map colour palettes (explorer/palettes.json, the same list the JPEG export uses)
    try:
        palettes_json = _PALETTES_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        palettes_json = "{}"
    html = html.replace("/*@PALETTES@*/{}", palettes_json, 1)
    return html


def index(request):
    """Serve the Explorer single-page application with live CSV data."""
    return HttpResponse(_render_page())


def map_page(request):
    """
    Serve the Spatial Environmental Mapping panel on its own (the dashboard's
    "Open in new window" button). Same page, flagged with ``map-standalone`` on
    ``<html>`` so its CSS shows only the map workspace with a way back.
    """
    html = _render_page()
    # ?embed=1: shown in the dashboard's Spatial Mapping tab, under its own header and menu
    cls = "map-standalone map-embed" if request.GET.get("embed") == "1" else "map-standalone"
    html = html.replace('<html lang="en">', f'<html lang="en" class="{cls}">', 1)
    html = html.replace(
        "<title>Ireland Greenhouse Gas Policy Impact Explorer</title>",
        "<title>Spatial Environmental Mapping · Ireland GHG Policy Impact Explorer</title>", 1)
    return HttpResponse(html)


def mapeire_catalog(request):
    """Grid geometry, years, sectors, pollutants, colour scales and credits for the MapEIre layers."""
    data = mapeire.catalog()
    if not data:
        return JsonResponse({"ok": False, "detail": "MapEIre layers are not available."}, status=503)
    resp = JsonResponse({"ok": True, **data}, json_dumps_params={"ensure_ascii": False})
    resp["Cache-Control"] = "no-cache"          # always revalidated: it names the data version of the layers
    return resp


def mapeire_layer(request):
    """Stored cell integers (with their scale / offset), unit, totals and colour scale of one MapEIre layer."""
    q = {k: (request.GET.get(k) or "").strip() for k in ("year", "sector", "pollutant")}
    try:
        data = mapeire.layer(**q)
    except Exception:
        logger.exception("Failed to load MapEIre layer %s", q)
        return JsonResponse({"ok": False, "detail": "The MapEIre layer could not be loaded."}, status=500)
    if data is None:
        return JsonResponse({"ok": False, "detail": "Unknown MapEIre selection."}, status=404)
    resp = JsonResponse({"ok": True, **data}, json_dumps_params={"ensure_ascii": False, "separators": (",", ":")})
    resp["Cache-Control"] = "public, max-age=3600"
    return resp


def edgar_catalog(request):
    """Grid geometry, years, gases, sectors and credits for the EDGAR layers."""
    data = edgar.catalog()
    if not data:
        return JsonResponse({"ok": False, "detail": "EDGAR layers are not available."}, status=503)
    return JsonResponse({"ok": True, **data}, json_dumps_params={"ensure_ascii": False})


def edgar_layer(request):
    """Cell values, unit and colour scale for one EDGAR gas/sector/year/month."""
    q = {k: (request.GET.get(k) or "").strip() for k in ("gas", "sector", "year", "month")}
    try:
        data = edgar.layer(**q)
    except Exception:
        logger.exception("Failed to load EDGAR layer %s", q)
        return JsonResponse({"ok": False, "detail": "The EDGAR layer could not be loaded."}, status=500)
    if data is None:
        return JsonResponse({"ok": False, "detail": "Unknown EDGAR selection."}, status=404)
    resp = JsonResponse({"ok": True, **data}, json_dumps_params={"ensure_ascii": False})
    resp["Cache-Control"] = "public, max-age=3600"
    return resp


def overlay_catalog(request):
    """The vector overlay layers (Layer Overlay list): names, fields, value ranges, extents."""
    return JsonResponse({"ok": True, **overlays.catalog()}, json_dumps_params={"ensure_ascii": False})


def overlay_layer(request, layer_id):
    """One packed overlay layer, sent gzipped (built by scripts/build_overlays.py)."""
    path = overlays.layer_path(layer_id)
    if path is None:
        return JsonResponse({"ok": False, "detail": "Unknown overlay layer."}, status=404)
    gzip_ok = "gzip" in request.META.get("HTTP_ACCEPT_ENCODING", "")
    try:
        body = overlays.read_layer(path, gzip_ok)
    except OSError:
        logger.exception("Failed to read overlay layer %s", layer_id)
        return JsonResponse({"ok": False, "detail": "The overlay layer could not be loaded."}, status=500)
    resp = HttpResponse(body, content_type="application/json; charset=utf-8")
    if gzip_ok:
        resp["Content-Encoding"] = "gzip"
    resp["Vary"] = "Accept-Encoding"
    resp["Cache-Control"] = "public, max-age=86400"
    return resp


_TS_KEYS = ("dataset", "where", "agg", "gas", "sector", "step", "model", "transport", "estimate", "poly",
            "county", "lat", "lng", "s", "w", "n", "e")


def map_counties(request):
    """County outlines for the time series County region (built by scripts/build_counties.py)."""
    path = timeseries.COUNTIES_PATH
    if not path.exists():
        return JsonResponse({"ok": False, "detail": "No county boundaries."}, status=404)
    resp = HttpResponse(path.read_bytes(), content_type="application/json; charset=utf-8")
    resp["Cache-Control"] = "public, max-age=86400"
    return resp


def map_timeseries(request):
    """Time series of one EDGAR / inverse-model layer at a pixel, a region or the whole of Ireland."""
    q = {k: (request.GET.get(k) or "").strip() for k in _TS_KEYS}
    try:
        data = timeseries.series(q)
    except timeseries.SelectionError as err:
        return JsonResponse({"ok": False, "detail": str(err)}, status=422)
    except Exception:
        logger.exception("Failed to build time series %s", q)
        return JsonResponse({"ok": False, "detail": "The time series could not be built."}, status=500)
    if data is None:
        return JsonResponse({"ok": False, "detail": "Unknown time series selection."}, status=404)
    resp = JsonResponse({"ok": True, **data}, json_dumps_params={"ensure_ascii": False})
    resp["Cache-Control"] = "public, max-age=3600"
    return resp


def inverse_catalog(request):
    """Grid geometry, runs and their years, gases and credits for the inverse-model layers."""
    data = inverse.catalog()
    if not data:
        return JsonResponse({"ok": False, "detail": "Inverse model layers are not available."}, status=503)
    return JsonResponse({"ok": True, **data}, json_dumps_params={"ensure_ascii": False})


def inverse_layer(request):
    """Prior / posterior cell values, uncertainty range and Ireland totals for one run and year."""
    q = {k: (request.GET.get(k) or "").strip() for k in ("model", "transport", "gas", "year")}
    try:
        data = inverse.layer(**q)
    except Exception:
        logger.exception("Failed to load inverse-model layer %s", q)
        return JsonResponse({"ok": False, "detail": "The inverse model layer could not be loaded."}, status=500)
    if data is None:
        return JsonResponse({"ok": False, "detail": "Unknown inverse model selection."}, status=404)
    resp = JsonResponse({"ok": True, **data}, json_dumps_params={"ensure_ascii": False})
    resp["Cache-Control"] = "public, max-age=3600"
    return resp


_LAYER_KEYS = ("year", "sector", "parameter", "gas", "month", "model", "transport", "estimate")
# Plus a second layer (b_*) and the difference mode when comparing two layers
_EXPORT_KEYS = ("dataset", "compare", "mode", *_LAYER_KEYS, *(f"b_{k}" for k in _LAYER_KEYS),
                # the colours, colour range slider and background value of the map's "Map style" step
                "palette", "div_palette", "reverse", "rlo", "rhi", "rinv", "conf", "bg",
                # the time series region (county, drawn polygon or box s/w/n/e): only its cells, its
                # own colour range and its boundary
                "region", "county", "poly", "s", "w", "n", "e",
                # the time series grid (fmt="grid"): one map per time step in rows × cols panels
                "rows", "cols",
                # ... plus a last panel with each map's statistics (year, max, mean, min, median, std)
                "stats")


def map_export(request, fmt):
    """
    Download the layer selected on the map as a GeoTIFF (``fmt="geotiff"``),
    a JPEG map with legend (``fmt="jpeg"``) or both in one ZIP (``fmt="zip"``).
    Same query as the layer endpoints plus ``dataset`` (mapeire | edgar | inverse).
    ``fmt="grid"``: a JPEG with one map per time step (``rows`` × ``cols`` panels, one legend);
    ``fmt="steps"``: those time steps as JSON, for the page's panel layout choices.
    """
    if fmt not in ("geotiff", "jpeg", "zip", "grid", "steps"):
        return JsonResponse({"ok": False, "detail": "Format must be geotiff, jpeg, zip, grid or steps."}, status=404)
    q = {k: (request.GET.get(k) or "").strip() for k in _EXPORT_KEYS}
    if fmt == "steps":
        try:
            steps, info = map_export_mod.grid_steps(q)
        except map_export_mod.SelectionError as exc:
            return JsonResponse({"ok": False, "detail": str(exc)}, status=404)
        return JsonResponse({"ok": True, "n": len(steps), "labels": [label for _, label in steps], "what": info["what"]},
                            json_dumps_params={"ensure_ascii": False})
    try:
        with map_export_mod.use_palette(map_export_mod.Palette.from_query(q)):
            if fmt == "grid":
                try:
                    rows, cols = int(q["rows"]), int(q["cols"])
                except ValueError:
                    raise map_export_mod.SelectionError("Choose the number of rows and columns.")
                body, filename = map_export_mod.grid_jpeg(q, rows, cols, q["region"] == "1", q["stats"] == "1")
                resp = HttpResponse(body, content_type="image/jpeg")
                resp["Content-Disposition"] = f'attachment; filename="{filename}"'
                resp["Cache-Control"] = "public, max-age=3600"
                return resp
            layer = map_export_mod.build_layer(q)
            if q["region"] == "1":
                layer = map_export_mod.clip_to_region(layer, q)
            if fmt == "zip":
                files = [map_export_mod.geotiff(layer), map_export_mod.jpeg(layer)]
                buf = io.BytesIO()
                with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                    for data, name in files:
                        zf.writestr(name, data)
                body, filename = buf.getvalue(), files[0][1].rsplit(".", 1)[0] + ".zip"
            else:
                body, filename = (map_export_mod.geotiff if fmt == "geotiff" else map_export_mod.jpeg)(layer)
    except map_export_mod.SelectionError as exc:
        return JsonResponse({"ok": False, "detail": str(exc)}, status=404)
    except Exception:
        logger.exception("Failed to export map layer %s as %s", q, fmt)
        return JsonResponse({"ok": False, "detail": "The map could not be exported."}, status=500)
    resp = HttpResponse(body, content_type={"geotiff": "image/tiff", "jpeg": "image/jpeg", "zip": "application/zip"}[fmt])
    resp["Content-Disposition"] = f'attachment; filename="{filename}"'
    resp["Cache-Control"] = "public, max-age=3600"
    return resp


# ---------------------------------------------------------------------------
# Feedback endpoints
# ---------------------------------------------------------------------------
# The consultation: questionnaires in feedback_survey.py, storage and exports in
# feedback_store.py. Members of the public answer without a key; the four other groups
# exchange their group's access key for a signed token (valid ACCESS_HOURS), which opens
# their questionnaire and the results dashboard. Simple guards against automated or
# accidental submissions: a size limit, a hidden "website" field people never fill, a
# minimum completion time, a per-address rate limit and a limit on wrong keys (per
# gunicorn worker, in memory).
_FB_RATE = {}                      # client address -> recent submission times
_FB_RATE_MAX, _FB_RATE_WINDOW = 5, 3600
_FB_KEYFAIL = {}                   # client address -> recent wrong-key times
_FB_KEYFAIL_MAX, _FB_KEYFAIL_WINDOW = 8, 900
ACCESS_SALT, ACCESS_HOURS = "inpact.feedback.access", 12
# A key holder who submits gets a results pass: the results open only after completing the questionnaire
RESULTS_SALT, RESULTS_DAYS = "inpact.feedback.results", 90
# The whole Feedback section is closed until the visitor enters the section code (while the
# consultation is revised for GDPR). The code is FEEDBACK_GATE_CODE in /etc/inpact/inpact.env
# (never in Git); while it is unset the section cannot be opened. The code is exchanged at /api/feedback/gate/ for a signed token (valid GATE_HOURS) that the
# page sends as the X-Feedback-Gate header to every other feedback endpoint.
GATE_SALT, GATE_HOURS = "inpact.feedback.gate", 12


def _gate_code():
    return os.environ.get("FEEDBACK_GATE_CODE", "").strip()


def _gate_ok(request):
    """True when the request carries a valid Feedback-section token."""
    token = request.headers.get("X-Feedback-Gate", "")
    if not token:
        return False
    try:
        data = signing.loads(str(token), salt=GATE_SALT, max_age=GATE_HOURS * 3600)
    except signing.BadSignature:
        return False
    return isinstance(data, dict) and data.get("gate") is True


def _gate_closed():
    resp = JsonResponse({"ok": False, "gate": True,
                         "detail": "The feedback section is closed. Enter the access code to open it."}, status=403)
    resp["X-Feedback-Gate"] = "closed"
    return resp


def _client_addr(request):
    # X-Real-IP is set by the proxy (nginx: $remote_addr; Vercel likewise) and overwrites
    # anything the client sends. The first X-Forwarded-For entry is NOT used: a client can
    # write any address there and so dodge the rate limits below.
    return (request.META.get("HTTP_X_REAL_IP", "").strip()
            or request.META.get("REMOTE_ADDR", "") or "?")


def _too_many_key_failures(addr, now):
    """Recent wrong-key attempts from this address, or None once it has hit the limit."""
    fails = [t for t in _FB_KEYFAIL.get(addr, []) if now - t < _FB_KEYFAIL_WINDOW]
    return None if len(fails) >= _FB_KEYFAIL_MAX else fails


def _access_group(token):
    """The keyed group a signed access token was issued to, or None."""
    if not token:
        return None
    try:
        data = signing.loads(str(token), salt=ACCESS_SALT, max_age=ACCESS_HOURS * 3600)
    except signing.BadSignature:
        return None
    g = data.get("g") if isinstance(data, dict) else None
    return g if g in feedback_survey.KEYED_GROUPS else None


def _results_group(token):
    """The keyed group a results pass (issued on submission) belongs to, or None."""
    if not token:
        return None
    try:
        data = signing.loads(str(token), salt=RESULTS_SALT, max_age=RESULTS_DAYS * 86400)
    except signing.BadSignature:
        return None
    g = data.get("g") if isinstance(data, dict) else None
    return g if g in feedback_survey.KEYED_GROUPS else None


def _json_body(request):
    try:
        data = json.loads(request.body.decode("utf-8") or "{}")
    except (ValueError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


@csrf_exempt
@require_POST
def feedback_gate(request):
    """Open the Feedback section. Body: {"code": "..."}. Returns {"ok": true, "token": ..., "hours": ...}."""
    data = _json_body(request)
    if data is None or len(request.body) > 2048:
        return JsonResponse({"ok": False, "detail": "Could not read the request."}, status=400)
    now, addr = time.time(), _client_addr(request)
    fails = _too_many_key_failures(addr, now)
    if fails is None:
        return JsonResponse({"ok": False, "detail": "Too many attempts. Please wait 15 minutes and try again."},
                            status=429)
    code, expected = str(data.get("code") or "").strip(), _gate_code()
    if not expected or not hmac.compare_digest(code.encode("utf-8"), expected.encode("utf-8")):
        _FB_KEYFAIL[addr] = fails + [now]
        time.sleep(0.6)                                       # slows down guessing
        return JsonResponse({"ok": False, "detail": "This code is not valid."}, status=403)
    token = signing.dumps({"gate": True}, salt=GATE_SALT, compress=True)
    return JsonResponse({"ok": True, "token": token, "hours": GATE_HOURS})


def feedback_schema(request):
    """The questionnaires (groups, steps, questions, answer codes) for the Feedback tab."""
    if not _gate_ok(request):
        return _gate_closed()
    schema = feedback_survey.public_schema()
    for g in schema["groups"]:                       # a keyed group without a key on the server is closed
        g["open"] = (not g["keyed"]) or bool(feedback_store.group_key(g["code"]))
    resp = JsonResponse(schema)
    resp["Cache-Control"] = "no-cache"
    resp["Vary"] = "X-Feedback-Gate"
    return resp


@csrf_exempt
@require_POST
def feedback_access(request):
    """
    Check a group's access key. Body: {"key": "...", "group": "researcher"} (group optional:
    without it, the key decides the group, as in the results unlock form).
    Returns {"ok": true, "group": ..., "label": ..., "token": ...}.
    """
    if not _gate_ok(request):
        return _gate_closed()
    data = _json_body(request)
    if data is None or len(request.body) > 2048:
        return JsonResponse({"ok": False, "detail": "Could not read the request."}, status=400)
    now, addr = time.time(), _client_addr(request)
    fails = _too_many_key_failures(addr, now)
    if fails is None:
        return JsonResponse({"ok": False, "detail": "Too many attempts. Please wait 15 minutes and try again."},
                            status=429)
    group, key = data.get("group"), data.get("key")
    if group:
        ok = feedback_store.check_group_key(group, key)
    else:
        group = feedback_store.find_group_for_key(key)
        ok = group is not None
    if not ok:
        _FB_KEYFAIL[addr] = fails + [now]
        time.sleep(0.6)                                       # slows down guessing
        label = feedback_survey.group_label(group).lower() if group else ""
        return JsonResponse({"ok": False, "detail": "This key is not valid" +
                             (f" for the {label} group." if label else ".")}, status=403)
    token = signing.dumps({"g": group}, salt=ACCESS_SALT, compress=True)
    return JsonResponse({"ok": True, "group": group, "label": feedback_survey.group_label(group),
                         "token": token, "hours": ACCESS_HOURS})


def feedback_summary(request):
    """Aggregated results: only for key holders who completed the questionnaire (results pass)."""
    if not _gate_ok(request):
        return _gate_closed()
    group = _results_group(request.headers.get("X-Feedback-Results"))
    if not group:
        return JsonResponse({"ok": False, "detail": "The results are shown to stakeholders, researchers, experts "
                                                    "and policy makers after they complete the questionnaire."},
                            status=403)
    try:
        data = feedback_store.summary()
    except Exception:
        logger.exception("Feedback summary failed")
        return JsonResponse({"ok": False, "detail": "The results could not be computed."}, status=500)
    resp = JsonResponse({"ok": True, "viewer": group, **data})
    resp["Cache-Control"] = "no-store"
    return resp


@csrf_exempt
@require_POST
def submit_feedback(request):
    """Validate and store one survey response."""
    if not _gate_ok(request):
        return _gate_closed()
    if len(request.body) > 64 * 1024:
        return JsonResponse({"ok": False, "detail": "The submission is too large."}, status=413)
    data = _json_body(request)
    if data is None:
        return JsonResponse({"ok": False, "detail": "Could not read the submission."}, status=400)
    if data.get("website"):                                  # honeypot: answer politely, store nothing
        return JsonResponse({"ok": True, "response_id": "-"})
    answers = data.get("answers") if isinstance(data.get("answers"), dict) else {}
    group = answers.get("group")
    if group in feedback_survey.KEYED_GROUPS and _access_group(data.get("access")) != group:
        return JsonResponse({"ok": False, "code": "access", "detail": "Your access key has expired or does not "
                             "match the group you chose. Please enter the key again on the first page; your "
                             "answers are kept."}, status=403)
    try:
        elapsed = float(data.get("elapsed_s") or 0)
    except (TypeError, ValueError):
        elapsed = 0
    if elapsed < 20:
        return JsonResponse({"ok": False, "detail": "That was very quick. Please take a moment to "
                                                    "check your answers and submit again."}, status=400)
    now, addr = time.time(), _client_addr(request)
    recent = [t for t in _FB_RATE.get(addr, []) if now - t < _FB_RATE_WINDOW]
    if len(recent) >= _FB_RATE_MAX:
        return JsonResponse({"ok": False, "detail": "Too many submissions from this connection. "
                                                    "Please try again later."}, status=429)
    meta = {"device": "mobile" if str(data.get("device")) == "mobile" else "desktop"}
    try:
        result = feedback_store.save_response(data, meta)
    except feedback_store.InvalidResponse as exc:
        return JsonResponse({"ok": False, "detail": str(exc)}, status=400)
    except OSError:
        logger.exception("Could not store a feedback response")
        return JsonResponse({"ok": False, "detail": "Your answers could not be saved on the server. "
                                                    "Please try again later."}, status=500)
    _FB_RATE[addr] = recent + [now]
    if group in feedback_survey.KEYED_GROUPS:
        result["results_token"] = signing.dumps({"g": group}, salt=RESULTS_SALT, compress=True)
        result["results_days"] = RESULTS_DAYS
    return JsonResponse(result)


@csrf_exempt
def download_feedback(request):
    """
    Research export for the project team: POST the key (FEEDBACK_ADMIN_KEY) and a
    format ("xlsx" or "csv"). Downloads are disabled while no key is configured.
    """
    if request.method != "POST":
        return HttpResponse("Use the research-team download form in the Feedback tab.",
                            status=405, content_type="text/plain")
    key = feedback_store.admin_key()
    given = (request.POST.get("key") or "").strip()
    if not key:
        return HttpResponse("Downloads are not enabled on this server (FEEDBACK_ADMIN_KEY is not set).",
                            status=403, content_type="text/plain")
    now, addr = time.time(), _client_addr(request)
    fails = _too_many_key_failures(addr, now)
    if fails is None:
        return HttpResponse("Too many attempts. Please wait 15 minutes and try again.",
                            status=429, content_type="text/plain")
    if not hmac.compare_digest(given.encode(), key.encode()):
        _FB_KEYFAIL[addr] = fails + [now]
        time.sleep(1)                                        # slows down guessing
        return HttpResponse("The research-team key is not correct.", status=403, content_type="text/plain")
    stamp = time.strftime("%Y%m%d")
    if request.POST.get("format") == "csv":
        resp = HttpResponse(feedback_store.export_csv_zip(), content_type="application/zip")
        resp["Content-Disposition"] = f'attachment; filename="inpact_survey_{stamp}_csv.zip"'
    else:
        resp = HttpResponse(feedback_store.export_xlsx(),
                            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        resp["Content-Disposition"] = f'attachment; filename="inpact_survey_{stamp}.xlsx"'
    resp["Cache-Control"] = "no-store"
    return resp
