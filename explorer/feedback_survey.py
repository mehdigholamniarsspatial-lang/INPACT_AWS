"""
INPACT consultation: the questionnaire definition.

This module is the single source of truth for the Feedback tab. The same
definition is used to

* render the form in the browser (served as JSON by ``/api/feedback/schema/``),
* validate every submission on the server (``feedback_store.clean_response``),
* aggregate the results dashboard and write the codebook of the research export.

Respondent groups
-----------------
Every respondent first chooses a group (``GROUPS``). Members of the public answer
without a key; stakeholders, researchers, experts and policy makers enter the
access key of their group (environment variables ``FEEDBACK_KEY_<GROUP>`` on the
server, never in Git). Each group then answers its own questionnaire
(``FLOWS``). Questions that several groups answer share the same variable name and
answer codes (for example ``overall_effectiveness``), so groups can be compared.

When the wording or the answer codes change in a way that affects comparability,
bump ``SURVEY_VERSION``: every stored response carries the version it answered.

Question types
--------------
group    the respondent group (one of ``GROUPS``), chosen on the welcome page
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

SURVEY_VERSION = "2026.11-v2"
SURVEY_TITLE = "INPACT consultation on the effectiveness of Ireland's climate policies"

# ---------------------------------------------------------------------------
# Respondent groups
# ---------------------------------------------------------------------------
# code, label, plural, icon, who it is for, minutes, needs a key, key prefix
GROUPS = [
    ("public", "Member of the public", "Public", "bi-people",
     "Anyone living in Ireland or interested in its climate policy. Tell us how policy affects you "
     "and which measures you would support.", 5, False, ""),
    ("stakeholder", "Stakeholder", "Stakeholders", "bi-building",
     "Organisations affected by climate policy: businesses, farms, energy companies, community and "
     "civil-society groups, representative bodies.", 8, True, "SH"),
    ("researcher", "Researcher", "Researchers", "bi-mortarboard",
     "Academic and applied researchers working on climate, energy, environment, land use or economics.",
     8, True, "RS"),
    ("expert", "Expert / practitioner", "Experts", "bi-tools",
     "Technical specialists, consultants and advisers with professional expertise in one or more sectors.",
     8, True, "EX"),
    ("policymaker", "Policy maker", "Policy makers", "bi-bank",
     "Elected representatives, public servants and staff of state agencies, local authorities and "
     "EU institutions.", 8, True, "PM"),
]
GROUP_CODES = [g[0] for g in GROUPS]
KEYED_GROUPS = [g[0] for g in GROUPS if g[6]]
KEY_PREFIX = {g[0]: g[7] for g in GROUPS if g[6]}

# ---------------------------------------------------------------------------
# Answer scales
# ---------------------------------------------------------------------------
def _scale(*labels):
    return {"min": 1, "max": len(labels), "labels": {i + 1: l for i, l in enumerate(labels)}}


EFFECTIVENESS_5 = _scale("Very ineffective", "Ineffective", "Neither", "Effective", "Very effective")
LIKELIHOOD_5 = _scale("Very unlikely", "Unlikely", "Uncertain", "Likely", "Very likely")
FAMILIARITY_5 = _scale("Not familiar", "Slightly", "Moderately", "Very familiar", "Expert")
QUALITY_5 = _scale("Very poor", "Poor", "Fair", "Good", "Very good")
USEFUL_5 = _scale("Not useful", "Slightly useful", "Moderately useful", "Very useful", "Extremely useful")
AGREE_5 = _scale("Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree")
SUPPORT_5 = _scale("Strongly oppose", "Oppose", "Neutral", "Support", "Strongly support")
CONCERN_5 = _scale("Not at all concerned", "Not very concerned", "Somewhat concerned", "Very concerned",
                   "Extremely concerned")
IMPACT_5 = _scale("Very negative", "Negative", "No overall effect", "Positive", "Very positive")
CONFIDENCE_5 = _scale("Not at all confident", "Slightly confident", "Moderately confident", "Very confident",
                      "Fully confident")
AMBITION_5 = _scale("Far too weak", "Too weak", "About right", "Too strong", "Far too strong")
TRACK_5 = _scale("Far off track", "Off track", "Partly on track", "On track", "Ahead of plan")

SECTORS = [
    ("energy", "Electricity & energy industries"),
    ("transport", "Transport"),
    ("agriculture", "Agriculture"),
    ("buildings", "Residential & commercial buildings"),
    ("industry", "Industry & manufacturing"),
    ("waste", "Waste"),
    ("lulucf", "Land use, land-use change & forestry"),
]

# ---------------------------------------------------------------------------
# Shared questions (same variable and codes for every group that answers them)
# ---------------------------------------------------------------------------
def Q(qid, qtype, label, **kw):
    return {"id": qid, "type": qtype, "label": label, **kw}


REGION = Q("region", "single", "Where are you based?", options=[
    ("dublin", "Dublin"), ("leinster", "Rest of Leinster"), ("munster", "Munster"),
    ("connacht", "Connacht"), ("ulster_roi", "Ulster (Republic of Ireland)"),
    ("ni", "Northern Ireland"), ("abroad", "Outside Ireland"), ("na", "Prefer not to say")])
FAMILIARITY = Q("familiarity", "scale", "How familiar are you with Ireland's climate policies?",
                required=True, scale=FAMILIARITY_5)
EXPERIENCE = Q("experience", "single",
               "How many years have you worked on climate, energy or environmental issues?", options=[
                   ("none", "I do not work in this area"), ("lt2", "Less than 2 years"), ("y2_5", "2 to 5 years"),
                   ("y6_10", "6 to 10 years"), ("gt10", "More than 10 years")])
OVERALL = Q("overall_effectiveness", "scale",
            "Overall, how effective have Ireland's climate policies been in reducing greenhouse gas emissions?",
            required=True, dk=True, scale=EFFECTIVENESS_5)
TARGET = Q("target_2030", "scale",
           "How likely is Ireland to meet its legally binding target of a 51% cut in emissions by 2030 "
           "(compared with 2018)?", required=True, dk=True, scale=LIKELIHOOD_5)
PACE = Q("pace", "single", "Is the current pace of climate action in Ireland…", required=True, options=[
    ("too_slow", "Too slow"), ("about_right", "About right"), ("too_fast", "Too fast"), ("dk", "Don't know")])
BARRIERS = Q("barriers", "multi", "What are the main barriers to more effective policy?", max=3,
             hint="Choose up to three.", options=[
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
             ])
INSTRUMENTS = Q("instruments", "multi", "Which kinds of measures should be strengthened most?", max=3,
                hint="Choose up to three.", options=[
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
                ])
SECTOR_EFF = Q("sector_effectiveness", "matrix", "Effectiveness of policy in reducing emissions, by sector",
               dk=True, scale=EFFECTIVENESS_5, rows=SECTORS)
SECTORS_KNOWN = Q("sectors_known", "multi", "Which sectors do you know best?", max=3,
                  hint="Choose up to three.",
                  options=SECTORS + [("cross", "Climate policy in general (cross-sector)")])


def POLICIES_Q(criteria, max_n=6, intro_label="Policies you want to evaluate"):
    return Q("policy_ratings", "policies", intro_label, max=max_n, comment_max_len=400,
             scale=QUALITY_5, criteria=criteria)


C_EFF = ("effectiveness", "Effectiveness", "Has it reduced (or will it reduce) emissions?")
C_COST = ("efficiency", "Cost-efficiency", "Are the results worth the cost?")
C_FAIR = ("equity", "Fairness", "Are costs and benefits shared fairly?")
C_IMPL = ("implementation", "Implementation", "Has it been delivered as planned?")
C_EVID = ("evidence", "Evidence base", "Is there robust evidence on its impact?")
C_DESIGN = ("design", "Technical design", "Is it well designed for what it has to achieve?")
C_FEAS = ("feasibility", "Acceptability", "Is it politically and publicly acceptable?")


def FINAL(usefulness_label, extra=None):
    qs = [Q("key_change", "text", "What single change would most improve Ireland's climate policy?", max_len=1500)]
    qs += extra or []
    qs += [
        Q("comments", "text", "Any other comments on the policies or on the evidence shown in this dashboard?",
          max_len=1500),
        Q("platform_usefulness", "scale", usefulness_label, scale=USEFUL_5),
        Q("followup_consent", "check",
          "I would be willing to take part in a short follow-up interview with the research team."),
        Q("followup_email", "email", "E-mail address for the follow-up", depends_on="followup_consent",
          hint="Kept separately from your answers and used only to contact you about the interview."),
    ]
    return {"id": "final", "title": "Final thoughts", "icon": "bi-chat-square-quote",
            "intro": "Last questions. Everything here is optional.", "questions": qs}


def STEP(sid, title, icon, intro, questions):
    return {"id": sid, "title": title, "icon": icon, "intro": intro, "questions": questions}


OVERALL_STEP_FULL = STEP("overall", "Overall view", "bi-speedometer2",
                         "Your overall judgement of Irish climate policy since the 1990s.",
                         [OVERALL, TARGET, PACE, BARRIERS, INSTRUMENTS])
SECTORS_STEP = STEP("sectors", "Sectors", "bi-grid-3x3-gap",
                    "How effective has policy been in each sector? Skip any sector you cannot judge.",
                    [SECTOR_EFF])
POLICY_INTRO = ("Choose up to six policies from the dashboard's policy timeline that you know well, "
                "and rate each one. You can skip this step.")

# ---------------------------------------------------------------------------
# The welcome page (everyone)
# ---------------------------------------------------------------------------
WELCOME = STEP("welcome", "Welcome", "bi-clipboard2-check",
               "The INPACT research project (funded by the Environmental Protection Agency) studies how "
               "national, EU and international policies have shaped Ireland's greenhouse gas emissions. "
               "Alongside the statistical evidence on this platform, we want to understand how the public, "
               "stakeholders, researchers, experts and policy makers judge these policies.",
               [
                   Q("group", "group", "Which group are you answering as?", required=True,
                     hint="Each group has its own questionnaire. Stakeholders, researchers, experts and policy "
                          "makers need the access key they received from the INPACT team."),
                   Q("consent", "check",
                     "I am 18 or older, I have read the information above and I agree that my anonymous answers "
                     "are used for research and may be published in aggregated form.", required=True),
               ])

# ---------------------------------------------------------------------------
# One questionnaire per group
# ---------------------------------------------------------------------------
FLOWS = {
    # ---- Members of the public: short, plain language, about everyday life ----
    "public": [
        STEP("profile", "About you", "bi-person", "A few questions so that answers can be compared between "
             "groups of people. Nothing here identifies you.", [
                 Q("age_band", "single", "Your age group", options=[
                     ("18_24", "18–24"), ("25_34", "25–34"), ("35_49", "35–49"), ("50_64", "50–64"),
                     ("65p", "65 or older"), ("na", "Prefer not to say")]),
                 REGION,
                 Q("area_type", "single", "Do you live in…", options=[
                     ("city", "A city"), ("town", "A town or village"), ("rural", "The countryside"),
                     ("na", "Prefer not to say")]),
                 Q("climate_concern", "scale", "How concerned are you about climate change?", required=True,
                   scale=CONCERN_5),
                 Q("knowledge", "scale", "How much do you know about what the Government does on climate change?",
                   required=True, scale=_scale("Nothing", "A little", "Some", "Quite a lot", "A great deal")),
             ]),
        STEP("views", "Your views", "bi-speedometer2", "Your view of climate policy in Ireland. "
             "There are no right or wrong answers.", [
                 Q("overall_effectiveness", "scale",
                   "Overall, how well have Government policies worked to reduce Ireland's greenhouse gas emissions?",
                   required=True, dk=True, scale=EFFECTIVENESS_5),
                 Q("target_2030", "scale",
                   "Ireland has promised by law to cut its emissions by about half by 2030. How likely is it to "
                   "succeed?", required=True, dk=True, scale=LIKELIHOOD_5),
                 PACE,
                 Q("fairness", "scale", "The costs of climate action are shared fairly between people in Ireland.",
                   dk=True, scale=AGREE_5),
                 Q("measure_support", "matrix", "Do you support or oppose these measures?", dk=True,
                   scale=SUPPORT_5, rows=[
                       ("carbon_tax", "A carbon tax on fuels, with the money returned to households"),
                       ("retrofit", "Grants to insulate homes and install heat pumps"),
                       ("ev", "Incentives for electric cars"),
                       ("public_transport", "More and cheaper public transport"),
                       ("active_travel", "Safer cycling and walking routes"),
                       ("renewables", "More wind and solar farms"),
                       ("herd", "Paying farmers to reduce livestock numbers"),
                       ("peatland", "Restoring bogs and planting forests"),
                   ]),
             ]),
        STEP("everyday", "Everyday life", "bi-house-heart", "How climate action fits into your own life.", [
            Q("actions_taken", "multi", "Which of these have you done in the last five years?", max=9,
              hint="Choose all that apply.", options=[
                  ("insulation", "Insulated or retrofitted my home"), ("heat_pump", "Installed a heat pump"),
                  ("solar", "Installed solar panels"), ("ev", "Bought an electric or hybrid car"),
                  ("transit", "Use public transport more"), ("active", "Walk or cycle more"),
                  ("flying", "Fly less"), ("diet", "Changed my diet"), ("none", "None of these")]),
            Q("personal_barriers", "multi", "What makes it hardest for you to do more?", max=3,
              hint="Choose up to three.", options=[
                  ("cost", "Cost"), ("renting", "I rent, or cannot change my home"),
                  ("no_alternative", "No practical alternative where I live"),
                  ("information", "Not enough clear information"), ("time", "Time and hassle"),
                  ("not_convinced", "I'm not convinced it makes a difference"),
                  ("nothing", "Nothing, I already do what I can"), ("other", "Other")]),
            Q("policy_impact", "scale", "Overall, how have climate policies affected you and your household?",
              dk=True, scale=IMPACT_5),
        ]),
        STEP("policies", "Policies", "bi-journal-check",
             "If you know any of the policies in the dashboard's timeline, choose up to three and tell us what "
             "you think of them. You can skip this step.",
             [POLICIES_Q([C_EFF, ("equity", "Fairness", "Is it fair to people like you?")], max_n=3)]),
        FINAL("How useful is this dashboard for understanding climate policy in Ireland?"),
    ],

    # ---- Stakeholders: organisations affected by policy ----
    "stakeholder": [
        STEP("profile", "Your organisation", "bi-building", "About the organisation or sector you speak for. "
             "Please do not name your organisation.", [
                 Q("org_type", "single", "Which best describes your organisation?", required=True, options=[
                     ("business", "Business / industry"), ("agri", "Farm or agri-food business"),
                     ("energy", "Energy company or utility"), ("rep_body", "Trade association or representative body"),
                     ("ngo", "Environmental NGO / civil society"), ("community", "Community group or co-operative"),
                     ("trade_union", "Trade union"), ("other", "Other")]),
                 Q("sectors_known", "multi", "Which sectors is your organisation active in?", max=3,
                   hint="Choose up to three.", required=True, options=SECTORS + [("cross", "Several / cross-sector")]),
                 Q("org_size", "single", "Size of your organisation", options=[
                     ("micro", "Fewer than 10 people"), ("small", "10–49"), ("medium", "50–249"),
                     ("large", "250 or more"), ("na", "Not applicable")]),
                 REGION, FAMILIARITY,
             ]),
        OVERALL_STEP_FULL,
        STEP("impact", "Impact on your sector", "bi-diagram-3",
             "How climate policy affects the organisations and people you represent.", [
                 Q("sector_impact", "matrix", "How far do you agree with these statements about your sector?",
                   dk=True, scale=AGREE_5, rows=[
                       ("costs", "The cost of complying with climate policy is manageable"),
                       ("opportunity", "Climate policy creates economic opportunities for us"),
                       ("clarity", "The rules and targets are clear and stable enough to plan investment"),
                       ("support", "Financial and technical support is adequate"),
                       ("consulted", "Our sector has been properly consulted"),
                       ("transition", "Workers and communities in our sector are supported in the transition"),
                   ]),
                 Q("net_impact", "scale", "Overall, what effect has climate policy had on your sector so far?",
                   dk=True, scale=IMPACT_5),
                 SECTOR_EFF,
             ]),
        STEP("policies", "Policies", "bi-journal-check", POLICY_INTRO,
             [POLICIES_Q([C_EFF, C_COST, C_FAIR, C_IMPL])]),
        FINAL("How useful is this dashboard for your organisation?", [
            Q("support_needed", "text", "What support would most help your sector cut its emissions?", max_len=1500)]),
    ],

    # ---- Researchers: evidence, data and methods ----
    "researcher": [
        STEP("profile", "Your research", "bi-mortarboard", "About your research background.", [
            Q("discipline", "single", "Your main discipline", required=True, options=[
                ("economics", "Economics"), ("env_science", "Environmental / climate science"),
                ("engineering", "Engineering / energy systems"), ("social", "Social or political science"),
                ("geography", "Geography / spatial science"), ("agri_science", "Agricultural or land science"),
                ("health", "Public health"), ("other", "Other")]),
            Q("career_stage", "single", "Career stage", options=[
                ("phd", "PhD researcher"), ("postdoc", "Postdoctoral researcher"),
                ("lecturer", "Lecturer / research fellow"), ("senior", "Senior lecturer / professor"),
                ("applied", "Researcher in a state agency or institute"), ("other", "Other")]),
            SECTORS_KNOWN, EXPERIENCE, FAMILIARITY,
        ]),
        STEP("overall", "Overall view", "bi-speedometer2",
             "Your overall judgement of Irish climate policy since the 1990s.", [OVERALL, TARGET, PACE]),
        STEP("evidence", "Evidence & methods", "bi-clipboard-data",
             "How well can we tell whether Irish climate policies work?", [
                 Q("evidence_quality", "matrix", "Quality of the data and evidence on policy impact, by sector",
                   dk=True, scale=QUALITY_5, rows=SECTORS),
                 Q("attribution_confidence", "scale",
                   "How confident are you that changes in Ireland's emissions can be attributed to specific policies?",
                   required=True, dk=True, scale=CONFIDENCE_5),
                 Q("evidence_gaps", "multi", "Where are the largest evidence gaps?", max=3,
                   hint="Choose up to three.", options=[
                       ("ex_post", "Ex-post evaluations of individual policies"),
                       ("counterfactual", "Counterfactuals: what would have happened without the policy"),
                       ("subnational", "Regional and local emission data"),
                       ("distribution", "Distributional effects on households and regions"),
                       ("costs", "Costs and cost-effectiveness"),
                       ("behaviour", "Behaviour and uptake"),
                       ("interaction", "Interactions between policies"),
                       ("agri_measurement", "Measurement of agricultural emissions"),
                       ("lulucf", "Land use and forestry accounting"),
                   ]),
                 Q("methods", "multi", "Which methods should be used more to evaluate Irish climate policy?", max=3,
                   hint="Choose up to three.", options=[
                       ("econometric", "Econometric / structural-break analysis"),
                       ("quasi_exp", "Quasi-experimental designs"),
                       ("models", "Energy-system and integrated assessment models"),
                       ("lca", "Life-cycle assessment"), ("spatial", "Spatial and remote-sensing analysis"),
                       ("qualitative", "Qualitative and process-tracing studies"), ("mixed", "Mixed methods")]),
                 Q("data_access", "scale", "How easy is it to access the official data you need for research?",
                   scale=_scale("Very difficult", "Difficult", "Neither", "Easy", "Very easy")),
             ]),
        SECTORS_STEP,
        STEP("policies", "Policies", "bi-journal-check", POLICY_INTRO,
             [POLICIES_Q([C_EFF, C_COST, C_FAIR, C_EVID])]),
        FINAL("How useful is this dashboard for research?", [
            Q("research_priority", "text", "Which research question on Irish climate policy most needs answering?",
              max_len=1500)]),
    ],

    # ---- Experts and practitioners: sectors, technologies and delivery ----
    "expert": [
        STEP("profile", "Your expertise", "bi-tools", "About your professional expertise.", [
            Q("sectors_known", "multi", "Your main areas of expertise", max=3, hint="Choose up to three.",
              required=True, options=SECTORS + [("cross", "Climate policy in general (cross-sector)")]),
            Q("expert_org", "single", "Where do you work?", options=[
                ("consultancy", "Consultancy"), ("industry", "Industry or industry body"),
                ("agency", "State agency or regulator"), ("ngo", "NGO (technical or policy role)"),
                ("academia", "University or research institute"), ("independent", "Independent / self-employed"),
                ("other", "Other")]),
            EXPERIENCE, FAMILIARITY,
        ]),
        OVERALL_STEP_FULL,
        STEP("sectors", "Sectors", "bi-grid-3x3-gap",
             "Effectiveness and ambition of policy in each sector. Skip any sector you cannot judge.", [
                 SECTOR_EFF,
                 Q("ambition_gap", "matrix",
                   "Is the ambition of policy in each sector in line with what the 2030 target requires?",
                   dk=True, scale=AMBITION_5, rows=SECTORS),
             ]),
        STEP("delivery", "Technologies & delivery", "bi-lightning-charge",
             "Is Ireland deploying the key technologies and measures at the scale needed?", [
                 Q("tech_track", "matrix", "Progress towards the scale needed by 2030", dk=True, scale=TRACK_5, rows=[
                     ("offshore_wind", "Offshore wind"), ("onshore_res", "Onshore wind and solar"),
                     ("grid", "Grid reinforcement and storage"), ("retrofit", "Home retrofits and heat pumps"),
                     ("district_heat", "District heating"), ("ev", "Electric vehicles and charging"),
                     ("biomethane", "Biomethane / anaerobic digestion"),
                     ("agri_tech", "Low-emission farming practices (e.g. feed additives, slurry)"),
                     ("peatland", "Peatland rewetting"), ("forestry", "Afforestation"),
                 ]),
                 Q("delivery_constraints", "multi", "What most constrains delivery?", max=3,
                   hint="Choose up to three.", options=[
                       ("grid_connection", "Grid connection"), ("planning", "Planning and permitting"),
                       ("supply_chain", "Supply chains and equipment"), ("skills", "Skilled workforce"),
                       ("finance", "Access to finance"), ("objection", "Local objection"),
                       ("regulation", "Regulatory uncertainty"), ("coordination", "Coordination between bodies")]),
             ]),
        STEP("policies", "Policies", "bi-journal-check", POLICY_INTRO,
             [POLICIES_Q([C_EFF, C_COST, C_FAIR, C_IMPL, C_DESIGN])]),
        FINAL("How useful is this dashboard for your professional work?"),
    ],

    # ---- Policy makers: governance, implementation and evidence needs ----
    "policymaker": [
        STEP("profile", "Your role", "bi-bank", "About your role in policy. Please do not name your organisation.", [
            Q("gov_level", "single", "Where do you work?", required=True, options=[
                ("department", "Government department"), ("agency", "State agency or regulator"),
                ("local", "Local authority"), ("regional", "Regional assembly or body"),
                ("elected", "Oireachtas / elected office"), ("eu", "EU or international institution"),
                ("other", "Other")]),
            Q("pm_role", "single", "Your role", options=[
                ("elected", "Elected representative"), ("senior", "Senior official / manager"),
                ("officer", "Policy officer / analyst"), ("adviser", "Adviser"), ("other", "Other")]),
            Q("sectors_known", "multi", "Which policy areas do you work on?", max=3, hint="Choose up to three.",
              options=SECTORS + [("cross", "Climate policy in general (cross-sector)")]),
            EXPERIENCE, FAMILIARITY,
        ]),
        STEP("overall", "Overall view", "bi-speedometer2",
             "Your overall judgement of Irish climate policy since the 1990s.", [OVERALL, TARGET, PACE, INSTRUMENTS]),
        STEP("governance", "Governance & delivery", "bi-diagram-2",
             "How well the system for making and delivering climate policy works.", [
                 Q("governance", "matrix", "How far do you agree with these statements?", dk=True, scale=AGREE_5, rows=[
                     ("coherence", "Policies across government departments are coherent"),
                     ("budgets", "Carbon budgets and sectoral ceilings effectively guide decisions"),
                     ("resources", "Implementing bodies have enough staff and funding"),
                     ("monitoring", "Monitoring shows clearly whether measures are working"),
                     ("local_powers", "Local authorities have the powers they need to deliver"),
                     ("engagement", "Public engagement is sufficient to build acceptance"),
                 ]),
                 Q("barriers", "multi", "What are the main barriers to implementing climate policy?", max=3,
                   hint="Choose up to three.", options=BARRIERS["options"]),
                 Q("evidence_needs", "multi", "Which evidence would most improve policy decisions?", max=3,
                   hint="Choose up to three.", options=[
                       ("ex_ante", "Ex-ante appraisal of new measures"),
                       ("ex_post", "Ex-post evaluation of existing policies"),
                       ("projections", "Sectoral emission projections"),
                       ("distribution", "Distributional and social impacts"),
                       ("local_data", "Local and spatial data"), ("international", "International comparisons"),
                       ("macc", "Abatement costs (MACC)"), ("behaviour", "Behavioural insights")]),
             ]),
        SECTORS_STEP,
        STEP("policies", "Policies", "bi-journal-check", POLICY_INTRO,
             [POLICIES_Q([C_EFF, C_COST, C_FAIR, C_IMPL, C_FEAS])]),
        FINAL("How useful is this dashboard for policy decisions?"),
    ],
}


# ---------------------------------------------------------------------------
# Access
# ---------------------------------------------------------------------------
def group_label(code: str) -> str:
    return next((g[1] for g in GROUPS if g[0] == code), code)


def _opts(pairs):
    return [{"code": c, "label": l} for c, l in pairs]


def _q_json(q):
    q2 = {k: v for k, v in q.items() if k not in ("options", "rows", "criteria", "scale")}
    if "options" in q:
        q2["options"] = _opts(q["options"])
    if "rows" in q:
        q2["rows"] = _opts(q["rows"])
    if "criteria" in q:
        q2["criteria"] = [{"code": c, "label": l, "hint": h} for c, l, h in q["criteria"]]
    if "scale" in q:
        s = q["scale"]
        q2["scale"] = {"min": s["min"], "max": s["max"], "labels": {str(k): v for k, v in s["labels"].items()}}
    return q2


def _step_json(step):
    return {**{k: v for k, v in step.items() if k != "questions"}, "questions": [_q_json(q) for q in step["questions"]]}


def public_schema() -> dict:
    """The questionnaire as JSON for the browser (no keys: those stay on the server)."""
    return {
        "version": SURVEY_VERSION, "title": SURVEY_TITLE,
        "groups": [{"code": c, "label": l, "plural": p, "icon": i, "desc": d, "minutes": m, "keyed": k}
                   for c, l, p, i, d, m, k, _ in GROUPS],
        "welcome": _step_json(WELCOME),
        "flows": {g: [_step_json(s) for s in steps] for g, steps in FLOWS.items()},
    }


def questions(group: str | None = None):
    """(step id, question) for one group's questionnaire, welcome page included, in order."""
    for q in WELCOME["questions"]:
        yield WELCOME["id"], q
    for step in FLOWS.get(group, []):
        for q in step["questions"]:
            yield step["id"], q


def variables():
    """Every variable once, in questionnaire order: (step id, first question seen, [groups], [wordings])."""
    seen = {}
    for step_id, q in questions(None):
        seen[q["id"]] = [step_id, q, ["all"], [q["label"]]]
    for g in GROUP_CODES:
        for step in FLOWS[g]:
            for q in step["questions"]:
                if q["id"] not in seen:
                    seen[q["id"]] = [step["id"], q, [], []]
                v = seen[q["id"]]
                if g not in v[2]:
                    v[2].append(g)
                if q["label"] not in v[3]:
                    v[3].append(q["label"])
                if q["type"] == "policies":         # criteria differ by group: collect them all
                    have = {c for c, _, _ in v[1]["criteria"]}
                    extra = [c for c in q["criteria"] if c[0] not in have]
                    if extra:
                        v[1] = {**v[1], "criteria": list(v[1]["criteria"]) + extra}
    return [tuple(v) for v in seen.values()]
