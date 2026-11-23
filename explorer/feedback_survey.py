"""
INPACT stakeholder survey: the questionnaire definition.

This module is the single source of truth for the Feedback tab. The same
definition is used to

* render the form in the browser (served as JSON by ``/api/feedback/schema/``),
* validate every submission on the server (``feedback_store.clean_response``),
* write the codebook sheet of the research export (variable names, question
  wording, answer codes and labels).

Changing a question therefore changes all three together. When the wording or
the answer codes change in a way that affects comparability, bump
``SURVEY_VERSION``: every stored response carries the version it answered.

Question types
--------------
single   one code from ``options``
multi    up to ``max`` codes from ``options``
scale    an integer on ``scale`` (e.g. 1..5), or "dk" (don't know) if ``dk`` is set
matrix   one ``scale`` answer per row in ``rows`` (each row optional)
text     free text up to ``max_len`` characters
email    an e-mail address (only kept when the related consent box is ticked)
check    a single tick box (true / false)
policies the dashboard's policy list: pick up to ``max`` policies and rate each on
         ``criteria`` (scale), with an optional short comment
"""
from __future__ import annotations

SURVEY_VERSION = "2026.11-v1"
SURVEY_TITLE = "INPACT stakeholder survey on the effectiveness of Ireland's climate policies"

# Reusable answer scales -------------------------------------------------------
EFFECTIVENESS_5 = {
    "min": 1, "max": 5,
    "labels": {1: "Very ineffective", 2: "Ineffective", 3: "Neither", 4: "Effective", 5: "Very effective"},
}
LIKELIHOOD_5 = {
    "min": 1, "max": 5,
    "labels": {1: "Very unlikely", 2: "Unlikely", 3: "Uncertain", 4: "Likely", 5: "Very likely"},
}
FAMILIARITY_5 = {
    "min": 1, "max": 5,
    "labels": {1: "Not familiar", 2: "Slightly", 3: "Moderately", 4: "Very familiar", 5: "Expert"},
}
QUALITY_5 = {
    "min": 1, "max": 5,
    "labels": {1: "Very poor", 2: "Poor", 3: "Fair", 4: "Good", 5: "Very good"},
}
USEFUL_5 = {
    "min": 1, "max": 5,
    "labels": {1: "Not useful", 2: "Slightly useful", 3: "Moderately useful", 4: "Very useful", 5: "Extremely useful"},
}

SECTORS = [
    ("energy", "Electricity & energy industries"),
    ("transport", "Transport"),
    ("agriculture", "Agriculture"),
    ("buildings", "Residential & commercial buildings"),
    ("industry", "Industry & manufacturing"),
    ("waste", "Waste"),
    ("lulucf", "Land use, land-use change & forestry"),
]

# The questionnaire, in steps --------------------------------------------------
STEPS = [
    {
        "id": "consent",
        "title": "Welcome",
        "icon": "bi-clipboard2-check",
        "intro": (
            "The INPACT research project (funded by the Environmental Protection Agency) studies how "
            "national, EU and international policies have shaped Ireland's greenhouse gas emissions. "
            "Alongside the statistical evidence on this platform, we want to understand how the public, "
            "stakeholders and experts judge these policies."
        ),
        "questions": [
            {"id": "consent", "type": "check", "required": True,
             "label": "I am 18 or older, I have read the information above and I agree that my anonymous "
                      "answers are used for research and may be published in aggregated form."},
        ],
    },
    {
        "id": "profile",
        "title": "About you",
        "icon": "bi-person-badge",
        "intro": "A few questions about your background, so that answers can be compared between groups. "
                 "Nothing here identifies you.",
        "questions": [
            {"id": "role", "type": "single", "required": True,
             "label": "Which best describes the perspective you are answering from?",
             "options": [
                 ("public", "Member of the public"),
                 ("researcher", "Researcher / academic"),
                 ("policy_national", "Policymaker or public servant (national)"),
                 ("policy_local", "Local authority / regional body"),
                 ("business", "Industry / business"),
                 ("agriculture", "Farming / agri-food"),
                 ("energy_utility", "Energy sector / utility"),
                 ("ngo", "NGO / civil society / community group"),
                 ("student", "Student"),
                 ("other", "Other"),
             ]},
            {"id": "expertise", "type": "multi", "max": 3,
             "label": "Which sectors do you know best?", "hint": "Choose up to three.",
             "options": SECTORS + [("cross", "Climate policy in general (cross-sector)"), ("none", "None in particular")]},
            {"id": "familiarity", "type": "scale", "required": True, "scale": FAMILIARITY_5,
             "label": "How familiar are you with Ireland's climate policies?"},
            {"id": "experience", "type": "single",
             "label": "How many years have you worked on climate, energy or environmental issues?",
             "options": [("none", "I do not work in this area"), ("lt2", "Less than 2 years"),
                         ("y2_5", "2 to 5 years"), ("y6_10", "6 to 10 years"), ("gt10", "More than 10 years")]},
            {"id": "region", "type": "single",
             "label": "Where are you based?",
             "options": [("dublin", "Dublin"), ("leinster", "Rest of Leinster"), ("munster", "Munster"),
                         ("connacht", "Connacht"), ("ulster_roi", "Ulster (Republic of Ireland)"),
                         ("ni", "Northern Ireland"), ("abroad", "Outside Ireland"), ("na", "Prefer not to say")]},
        ],
    },
    {
        "id": "overall",
        "title": "Overall view",
        "icon": "bi-speedometer2",
        "intro": "Your overall judgement of Irish climate policy since the 1990s.",
        "questions": [
            {"id": "overall_effectiveness", "type": "scale", "required": True, "dk": True, "scale": EFFECTIVENESS_5,
             "label": "Overall, how effective have Ireland's climate policies been in reducing greenhouse gas emissions?"},
            {"id": "target_2030", "type": "scale", "required": True, "dk": True, "scale": LIKELIHOOD_5,
             "label": "How likely is Ireland to meet its legally binding target of a 51% cut in emissions by 2030 (compared with 2018)?"},
            {"id": "pace", "type": "single", "required": True,
             "label": "Is the current pace of climate action in Ireland…",
             "options": [("too_slow", "Too slow"), ("about_right", "About right"), ("too_fast", "Too fast"), ("dk", "Don't know")]},
            {"id": "barriers", "type": "multi", "max": 3,
             "label": "What are the main barriers to more effective policy?", "hint": "Choose up to three.",
             "options": [
                 ("funding", "Insufficient funding or investment"),
                 ("acceptance", "Public acceptance and behaviour change"),
                 ("planning", "Planning and permitting delays"),
                 ("enforcement", "Weak enforcement or monitoring"),
                 ("coherence", "Conflicting policies across sectors"),
                 ("technology", "Technology readiness or cost"),
                 ("agri_economy", "Economic weight of agriculture"),
                 ("skills", "Skills and capacity shortages"),
                 ("governance", "Governance and coordination"),
                 ("data", "Lack of data and evidence"),
                 ("other", "Other"),
             ]},
            {"id": "instruments", "type": "multi", "max": 3,
             "label": "Which kinds of measures should be strengthened most?", "hint": "Choose up to three.",
             "options": [
                 ("carbon_tax", "Carbon tax and pricing"),
                 ("ets", "EU Emissions Trading System"),
                 ("regulation", "Regulations and standards"),
                 ("grants", "Grants and subsidies (e.g. retrofit, EVs)"),
                 ("infrastructure", "Public infrastructure (grid, public transport, cycling)"),
                 ("agri_measures", "Agriculture and land-use measures"),
                 ("renewables", "Renewable energy deployment"),
                 ("just_transition", "Just transition and support for affected groups"),
                 ("information", "Information and awareness"),
                 ("innovation", "Research and innovation"),
             ]},
        ],
    },
    {
        "id": "sectors",
        "title": "Sectors",
        "icon": "bi-grid-3x3-gap",
        "intro": "How effective has policy been in each sector? Skip any sector you cannot judge.",
        "questions": [
            {"id": "sector_effectiveness", "type": "matrix", "dk": True, "scale": EFFECTIVENESS_5,
             "label": "Effectiveness of policy in reducing emissions, by sector",
             "rows": SECTORS},
        ],
    },
    {
        "id": "policies",
        "title": "Policies",
        "icon": "bi-journal-check",
        "intro": "Choose up to six policies from the dashboard's policy timeline that you know well, "
                 "and rate each one. You can skip this step.",
        "questions": [
            {"id": "policy_ratings", "type": "policies", "max": 6, "comment_max_len": 400,
             "label": "Policies you want to evaluate",
             "scale": QUALITY_5,
             "criteria": [
                 ("effectiveness", "Effectiveness", "Has it reduced (or will it reduce) emissions?"),
                 ("efficiency", "Cost-efficiency", "Are the results worth the cost?"),
                 ("equity", "Fairness", "Are costs and benefits shared fairly?"),
                 ("implementation", "Implementation", "Has it been delivered as planned?"),
             ]},
        ],
    },
    {
        "id": "final",
        "title": "Final thoughts",
        "icon": "bi-chat-square-quote",
        "intro": "Last questions. Everything here is optional.",
        "questions": [
            {"id": "key_change", "type": "text", "max_len": 1500,
             "label": "What single change would most improve Ireland's climate policy?"},
            {"id": "comments", "type": "text", "max_len": 1500,
             "label": "Any other comments on the policies or on the evidence shown in this dashboard?"},
            {"id": "platform_usefulness", "type": "scale", "scale": USEFUL_5,
             "label": "How useful is this dashboard for understanding the effect of climate policy?"},
            {"id": "followup_consent", "type": "check",
             "label": "I would be willing to take part in a short follow-up interview with the research team."},
            {"id": "followup_email", "type": "email", "depends_on": "followup_consent",
             "label": "E-mail address for the follow-up",
             "hint": "Kept separately from your answers and used only to contact you about the interview."},
        ],
    },
]


def _opts(pairs):
    return [{"code": c, "label": l} for c, l in pairs]


def public_schema() -> dict:
    """The questionnaire as JSON for the browser (tuples turned into objects)."""
    steps = []
    for step in STEPS:
        qs = []
        for q in step["questions"]:
            q2 = {k: v for k, v in q.items() if k not in ("options", "rows", "criteria")}
            if "options" in q:
                q2["options"] = _opts(q["options"])
            if "rows" in q:
                q2["rows"] = _opts(q["rows"])
            if "criteria" in q:
                q2["criteria"] = [{"code": c, "label": l, "hint": h} for c, l, h in q["criteria"]]
            if "scale" in q:
                s = q["scale"]
                q2["scale"] = {"min": s["min"], "max": s["max"],
                               "labels": {str(k): v for k, v in s["labels"].items()}}
            qs.append(q2)
        steps.append({**{k: v for k, v in step.items() if k != "questions"}, "questions": qs})
    return {"version": SURVEY_VERSION, "title": SURVEY_TITLE, "steps": steps}


def questions():
    """Every question with its step id, in order."""
    for step in STEPS:
        for q in step["questions"]:
            yield step["id"], q
