"""
INPACT consultation: the questionnaire definition (version 2026.12-v4.2).

This module is the single source of truth for the Feedback tab. It follows the
"INPACT Multi-Stakeholder Climate Policy Consultation and Evaluation Instrument",
version 2026.12-v4.2 (27 November 2026): Sections 3-11 (the questionnaire as
respondents see it) and Section 13 (routing, selection rules, randomisation, help
text). The same definition is used to

* render the form in the browser (served as JSON by ``/api/feedback/schema/``),
* validate every submission on the server, routing included (``feedback_store``),
* aggregate the results and write the codebook of the research export.

Question ids are the variable names of the document (``A2_eff_overall``,
``P9_support`` ...); grids, multiple-choice items and the policy module are expanded
into the codebook columns of Appendix A in the export.

Respondent groups (W1)
----------------------
Members of the public answer without a key and are randomly assigned to Form A
(Module G) or Form B (K2). Stakeholders, researchers, experts / practitioners and
policy makers enter the access key of their group (environment variables
``FEEDBACK_KEY_<GROUP>`` on the server, never in Git).

When wording, options or routing change, bump ``SURVEY_VERSION`` (Section 13.6).

Question types
--------------
group      the respondent group (W1), with the access key of keyed groups
single     one code from ``options``
multi      up to ``max`` codes from ``options``; ``exclusive`` codes cannot be combined
scale      one point of ``scale``, or one of the non-substantive codes in ``na``
matrix     one ``scale`` answer (or ``na`` code) per row of ``rows``
consents   tick boxes that must all be ticked (W6)
text       free text up to ``max_len`` characters
pickgrid   choose up to ``max`` items from another grid's rows, then rate each on ``rows`` (E7)
policies3  Module C: two reference policies (random order) and one of the respondent's choice

Optional keys: ``required``; ``hint``; ``help`` (glossary terms, Section 13.5);
``show_if`` (routing, see ``visible``); ``rows_from`` / ``options_from`` (rows or options
taken from an earlier answer); ``exclude_group`` (W2); ``other`` (the option code that
opens a 200-character "please specify" box, stored as ``<id>_other``); ``randomize``
(row order randomised and stored); ``randomize_first`` (the first n options randomised).
"""
from __future__ import annotations

import copy

SURVEY_VERSION = "2026.12-v4.2"
SURVEY_TITLE = "INPACT Multi-Stakeholder Climate Policy Consultation"

# ---------------------------------------------------------------------------
# Values confirmed by the research team for the items of Section 18 (27 November 2026).
# Only the ethics reference is still open; it appears in [square brackets] until it is set here.
# ---------------------------------------------------------------------------
CONFIRM = {
    "ethics_ref": "[reference number, date]",
    "withdraw_period": "within one week of submitting",     # the survey and reference codes are then deleted
    "code_days": 7,                                         # feedback_store deletes the codes after this many days
    "team_email": "mehgholamnia@gmail.com",
    "hosting": "Amazon Web Services (AWS), which hosts this platform,",
    "log_until": "May 2029",
    "minutes_public": "12–17",
    "minutes_pro": "18–23",
}

# ---------------------------------------------------------------------------
# Respondent groups
# ---------------------------------------------------------------------------
# code, label, plural, icon, who it is for, minutes, needs a key, key prefix
GROUPS = [
    ("public", "Member of the public", "Public", "bi-people",
     "Anyone living in Ireland or interested in its climate policy. Tell us how policy affects you "
     "and which measures you would support.", CONFIRM["minutes_public"], False, ""),
    ("stakeholder", "Stakeholder", "Stakeholders", "bi-building",
     "Organisations affected by climate policy: businesses, farms, energy companies, community and "
     "civil-society groups, representative bodies.", CONFIRM["minutes_pro"], True, "SH"),
    ("researcher", "Researcher", "Researchers", "bi-mortarboard",
     "Academic and applied researchers working on climate, energy, environment, land use or economics.",
     CONFIRM["minutes_pro"], True, "RS"),
    ("expert", "Expert / practitioner", "Experts", "bi-tools",
     "Technical specialists, consultants and advisers with professional expertise in one or more sectors.",
     CONFIRM["minutes_pro"], True, "EX"),
    ("policymaker", "Policy maker", "Policy makers", "bi-bank",
     "Elected representatives, public servants and staff of state agencies, local authorities and "
     "EU institutions.", CONFIRM["minutes_pro"], True, "PM"),
]
GROUP_CODES = [g[0] for g in GROUPS]
KEYED_GROUPS = [g[0] for g in GROUPS if g[6]]
PRO_GROUPS = KEYED_GROUPS                     # "professional groups" in the document
KEY_PREFIX = {g[0]: g[7] for g in GROUPS if g[6]}
FORMS = ("A", "B")                           # split ballot for the public (Section 2.2)

# ---------------------------------------------------------------------------
# Non-substantive answers (Section 2.5) and their codes in the export (Appendix A)
# ---------------------------------------------------------------------------
NS = {"ns": "Not sure", "ome": "Outside my expertise", "na": "Not applicable to me",
      "ii": "Insufficient information", "cj": "Cannot judge", "tea": "Too early to assess",
      "dk": "Don't know", "dkna": "Don't know / N/A", "pnts": "Prefer not to say"}
NS_NUM = {"ns": 92, "ome": 93, "na": 94, "ii": 95, "cj": 96, "tea": 97, "dk": 98, "dkna": 98, "pnts": 99}
MISSING_NOT_SHOWN, MISSING_NO_ANSWER = -1, -2
MISSING_I1 = (91, 90)                        # I1: negative values are valid scores


# ---------------------------------------------------------------------------
# Response scales (Section 2.5): substantive points are numbered from the lowest
# or least favourable category
# ---------------------------------------------------------------------------
def _scale(*labels, start=1, ends_only=False):
    return {"min": start, "max": start + len(labels) - 1,
            "labels": {start + i: l for i, l in enumerate(labels)}, "ends_only": ends_only}


FAMILIARITY = _scale("Not at all familiar", "Slightly familiar", "Moderately familiar", "Very familiar",
                     "Expert knowledge")
EFFECTIVENESS = _scale("Very ineffective", "Ineffective", "Neither effective nor ineffective", "Effective",
                       "Very effective")
CONFIDENCE = _scale("Not at all confident", "Slightly confident", "Moderately confident", "Very confident",
                    "Extremely confident")
LIKELIHOOD = _scale("Very unlikely", "Unlikely", "Neither likely nor unlikely", "Likely", "Very likely")
AGREEMENT = _scale("Strongly disagree", "Disagree", "Neither agree nor disagree", "Agree", "Strongly agree")
EXTENT = _scale("Not at all", "To a small extent", "To a moderate extent", "To a large extent",
                "To a very large extent")
SUPPORT = _scale("Strongly oppose", "Oppose", "Neither support nor oppose", "Support", "Strongly support")
IMPACT = _scale("Very negative", "Negative", "No overall effect", "Positive", "Very positive")
CHANGE = _scale("Decreased a lot", "Decreased", "No change", "Increased", "Increased a lot")
EVIDENCE = _scale("Very weak", "Weak", "Moderate", "Strong", "Very strong")
EASE = _scale("Very difficult", "Difficult", "Neither easy nor difficult", "Easy", "Very easy")
AMBITION = _scale("Far too weak", "Too weak", "About right", "Too strong", "Far too strong")
FEASIBILITY = _scale("Very low", "Low", "Moderate", "High", "Very high")
FREQUENCY = _scale("Never", "Rarely", "Sometimes", "Often", "Always")
USEFULNESS = _scale("Not at all useful", "Slightly useful", "Moderately useful", "Very useful",
                    "Extremely useful")
CLARITY = _scale("Not at all clear", "Slightly clear", "Moderately clear", "Very clear", "Extremely clear")
CONCERN = _scale("Not at all concerned", "Not very concerned", "Somewhat concerned", "Very concerned",
                 "Extremely concerned")
CONF_FIGURES = _scale("No confidence", "Little confidence", "Some confidence", "High confidence",
                      "Very high confidence")
TRUST = _scale("No trust at all", "Little trust", "Some trust", "A lot of trust", "Complete trust")
SEVERITY = _scale("Minor", "Moderate", "Major", "Critical")
INCOHERENCE = _scale("Never", "Rarely", "Sometimes", "Often", "Very often")
REDUCTION = _scale("Not at all", "A little", "A moderate amount", "A lot", "A great deal")
HH_COST = _scale("Reduce a lot", "Reduce a little", "No effect", "Increase a little", "Increase a lot")
INTERACTION = _scale("Cancelling", "Counteracting", "Constraining", "Consistent", "Enabling", "Reinforcing",
                     "Indivisible", start=-3)
TRUE_FALSE = _scale("Definitely true", "Probably true", "Probably false", "Definitely false")
FAIRNESS = _scale("Very unfair", "Unfair", "Neither fair nor unfair", "Fair", "Very fair")
VALUE = _scale("Very poor", "Poor", "Moderate", "Good", "Very good")
ACCEPTABILITY = _scale("Very unacceptable", "Unacceptable", "Neither acceptable nor unacceptable", "Acceptable",
                       "Very acceptable")
WORKABILITY = _scale("Very unworkable", "Unworkable", "Neither workable nor unworkable", "Workable",
                     "Very workable")
DESIGN = _scale("Very poor", "Poor", "Adequate", "Good", "Very good")
UMUX = _scale("Strongly disagree", "", "", "", "", "", "Strongly agree", ends_only=True)
QUALITY = _scale("Very poor", "Poor", "Fair", "Good", "Very good")
IMPORTANCE = _scale("Not important", "Slightly important", "Moderately important", "Very important",
                    "Extremely important")
PROGRESS = _scale("Far off track", "Off track", "Partly on track", "On track", "Ahead of plan")
ACTION = _scale("Done", "Plan to in the next two years", "Not done and not planned")

# ---------------------------------------------------------------------------
# Plain-language help text (Section 13.5)
# ---------------------------------------------------------------------------
HELP = {
    "inventory": ("Official figures / national inventory",
                  "The national greenhouse gas inventory, compiled by the EPA each year from data on activities "
                  "such as fuel use and livestock numbers."),
    "ceiling": ("Sectoral emissions ceiling",
                "A legal limit on the emissions of one sector of the economy over a five-year period."),
    "interaction": ("Policy interaction scale",
                    "+3 Indivisible: the two cannot be achieved separately. +2 Reinforcing: achieving the first "
                    "strongly helps achieve the second. +1 Enabling: achieving the first creates conditions that "
                    "help the second. 0 Consistent: no significant effect either way. −1 Constraining: achieving "
                    "the first limits the options for the second. −2 Counteracting: achieving the first works "
                    "against the second. −3 Cancelling: achieving the first makes the second impossible."),
    "break": ("Structural break", "A point in time where an emission trend changes direction or speed."),
    "topdown": ("Bottom-up inventory / top-down estimate",
                "A bottom-up inventory adds up emissions from activities such as fuel use and livestock "
                "numbers. A top-down estimate works backwards from measurements of greenhouse gases in the air."),
    "inverse": ("Inverse modelling",
                "A method that estimates emissions from atmospheric measurements and weather data."),
    "insitu": ("In-situ measurements",
               "Continuous measurements of greenhouse gases in the air at fixed monitoring stations, such as "
               "Mace Head in Co. Galway."),
    "attribution": ("Attribution",
                    "Showing how much of a change in emissions was caused by a particular policy, rather than by "
                    "other factors such as the economy or weather."),
    "counterfactual": ("Counterfactual", "An estimate of what would have happened without the policy."),
    "abatement": ("Abatement costs", "The cost of reducing one tonne of emissions with a given measure."),
    "institutional": ("Institutional feasibility",
                      "Whether the responsible bodies have the legal powers, staff and funding to deliver a "
                      "measure."),
    "just": ("Just transition",
             "Making sure the move to a low-carbon economy is fair to the workers, communities and households "
             "most affected."),
    "ets": ("EU Emissions Trading System",
            "An EU scheme that caps emissions from power stations, large industry and aviation, with tradable "
            "allowances."),
    "lulucf": ("LULUCF",
               "Land use, land-use change and forestry: emissions and removals from soils, peatlands, grassland "
               "and forests."),
}


# ---------------------------------------------------------------------------
# Building blocks
# ---------------------------------------------------------------------------
def Q(qid, qtype, label, **kw):
    return {"id": qid, "type": qtype, "label": label, **kw}


def STEP(sid, title, icon, intro, questions):
    return {"id": sid, "title": title, "icon": icon, "intro": intro, "questions": questions}


UP_TO = {2: "Choose up to two.", 3: "Choose up to three.", 4: "Choose up to four."}

SECTORS = [
    ("energy", "Electricity & energy industries"),
    ("transport", "Transport"),
    ("agriculture", "Agriculture"),
    ("buildings", "Residential & commercial buildings"),
    ("industry", "Industry & manufacturing"),
    ("waste", "Waste"),
    ("lulucf", "Land use, land-use change & forestry (LULUCF)"),
]
REGIONS = [("dublin", "Dublin"), ("leinster", "Rest of Leinster"), ("munster", "Munster"),
           ("connacht", "Connacht"), ("ulster_roi", "Ulster (Republic of Ireland)"),
           ("ni", "Northern Ireland"), ("abroad", "Outside Ireland"), ("pnts", "Prefer not to say")]
YEARS = [("none", "I do not work in this area"), ("lt2", "Less than 2 years"), ("y2_5", "2 to 5 years"),
         ("y6_10", "6 to 10 years"), ("gt10", "More than 10 years")]
PERSPECTIVE = [("own", "Mainly my own professional view"), ("org", "Mainly my organisation's position"),
               ("mix", "A mix of both"), ("pnts", "Prefer not to say")]
COST_GROUPS = [
    ("low_income", "Low-income households"), ("high_income", "Higher-income households"),
    ("renters", "Renters"), ("homeowners", "Homeowners"), ("rural", "Rural communities"),
    ("urban", "Urban communities"), ("farmers", "Farmers and farm families"), ("small_biz", "Small businesses"),
    ("large_biz", "Large businesses"), ("carbon_workers", "Workers in carbon-intensive industries"),
    ("older", "Older people"), ("young", "Young people and future generations"),
    ("no_group", "No group in particular"), ("dk", "Don't know"),
]

# ---------------------------------------------------------------------------
# Section 3: participant information (shown on the welcome page)
# ---------------------------------------------------------------------------
INFO = {
    "about": [
        ("About this survey",
         "The INPACT research project at the University of Galway, funded by the Environmental Protection "
         "Agency, studies how national, EU and international policies have shaped Ireland's greenhouse gas "
         "emissions. This survey asks members of the public, stakeholders, researchers, experts and policy "
         "makers what they think holds back climate policy, where policies pull against each other, and how "
         "fair and acceptable they find them. It also asks how useful you find this platform."),
        ("What we ask",
         "Everyone answers some common questions, then questions for their group, and then rates three "
         "policies. Some questions ask whether statements about climate policy are true or false; the correct "
         "answers are shown, with sources, at the end. The survey takes about {minutes_public} minutes for "
         "members of the public and {minutes_pro} minutes for the other groups. All written answers and many "
         "other questions are optional."),
        ("How your answers are used",
         "Answers are analysed as a group and compared with the emission data in this dashboard. They tell us "
         "how policies are seen; they are not used as proof that a policy did or did not reduce emissions. "
         "Results will be reported only in aggregated form, in INPACT reports, the dashboard and scientific "
         "publications, and may be used to plan an INPACT public workshop."),
        ("Ethical approval",
         "This study has been approved by the University of Galway Research Ethics Committee {ethics_ref}."),
    ],
    "data": [
        ("Who is responsible",
         "The University of Galway is the data controller. The survey is run by the INPACT research team "
         "(Principal Investigator: Dr Liz Coleman) with funding from the Environmental Protection Agency."),
        ("What we collect with your answers",
         "Your answers; the date of submission; the survey version; how long the survey took; the type of "
         "device (mobile or desktop); a random survey code, used to stop duplicate submissions; and the "
         "reference code you will see after submitting, used only if you want to withdraw. Professional "
         "respondents also enter an access key, which records their group. We do not ask for your name, your "
         "e-mail address or the name of your organisation."),
        ("What we do not collect",
         "The survey software does not record your IP address or location. {hosting} keeps technical server "
         "logs, including IP addresses, until {log_until} for security purposes. These logs are not linked "
         "to your answers and are not used for research."),
        ("Confidential, then anonymised",
         "While data are being collected, your answers are confidential and pseudonymous: they do not include "
         "your name, but they are stored with the survey code and reference code described above. One week "
         "after you submit, these codes are permanently deleted, and from then on your answers are "
         "anonymised."),
        ("Please do not include personal details",
         "about yourself or others in the text boxes. Before analysis, the team removes any names, "
         "organisations or other identifying details that appear in written answers."),
        ("Before you submit",
         "Nothing is sent until you press Submit on the last page. Until then your answers are kept only in "
         "this browser, so you can stop and come back later on the same device."),
        ("Small groups",
         "Results are never shown for a group of fewer than 5 people, and small categories are combined so "
         "that no one can be identified."),
        ("How long we keep your answers",
         "The anonymised answers are deleted as soon as the project ends, except answers that you allow us to "
         "include in an open research dataset (W8). Daily backups are deleted after 30 days."),
        ("Withdrawing",
         "You can stop at any time before you submit. After you submit, you will see a reference code. To "
         "withdraw, e-mail that code to {team_email} {withdraw_period}. We will delete your response within 10 "
         "working days and confirm by e-mail. After one week the codes are deleted, and answers can no longer "
         "be identified or removed."),
        ("Optional permissions",
         "You can decide separately whether we may quote your written answers (W7) and whether your anonymised "
         "answers may be included in an open research dataset (W8). Saying no does not affect your "
         "participation."),
        ("Questions and your rights",
         "Contact the research team at mehdi.gholamnia@universityofgalway.ie, or the University's Data "
         "Protection Officer at dataprotection@universityofgalway.ie. You also have the right to complain to "
         "the Data Protection Commission (www.dataprotection.ie)."),
    ],
}
# Shown after W1 to the four keyed groups (Section 4, access code box)
ACCESS_NOTE = ("The key places you in your group. Group membership is self-reported: the key does not verify who "
               "you are.")

# ---------------------------------------------------------------------------
# Module W: screening and consent (Section 4)
# ---------------------------------------------------------------------------
W1 = Q("group", "group", "W1. Which perspective will you answer from?", required=True,
       hint="Choose the one that best describes the role you will answer from today. You can tell us about other "
            "roles in the next question. Stakeholders, researchers, experts and policy makers need the access "
            "key they received from the INPACT team.")
W_ITEMS = [
    Q("W2_role", "multi", "W2. Do you also hold any of these other roles?", max=6, exclusive=["none"],
      exclude_group=True,
      hint="Choose all that apply. This lets us account for people who belong to more than one group.",
      options=[("public", "Member of the public"), ("stakeholder", "Stakeholder"), ("researcher", "Researcher"),
               ("expert", "Expert / practitioner"), ("policymaker", "Policy maker"), ("none", "None of these")]),
    Q("W3_channel", "single", "W3. How did you hear about this survey?", options=[
        ("invitation", "Invitation from the INPACT team"),
        ("network", "A professional network, mailing list or newsletter"), ("social", "Social media"),
        ("dashboard", "While browsing the INPACT dashboard"), ("event", "A public event or workshop"),
        ("community", "A community organisation"), ("news", "News media"), ("other", "Other")]),
    Q("W4_prior_use", "single", "W4. Before today, how often had you used the INPACT dashboard?", options=[
        ("never", "Never"), ("once", "Once or twice"), ("several", "Several times"), ("regular", "Regularly")]),
    Q("W5_exposure", "single",
      "W5. Today, about how long did you spend exploring the dashboard before starting this survey?", options=[
          ("none", "I did not explore it"), ("lt5", "Less than 5 minutes"), ("m5_15", "5 to 15 minutes"),
          ("m15_30", "15 to 30 minutes"), ("gt30", "More than 30 minutes")]),
    Q("W6_consent", "consents", "W6. Consent", required=True,
      hint="Please tick each statement to take part. All five are required.",
      rows=[("1", "I am 18 or older."),
            ("2", "I have read the participant information above, and I have had the chance to contact the "
                  "team with questions."),
            ("3", "I understand that taking part is voluntary and that I can stop at any time before I submit, "
                  "without giving a reason."),
            ("4", "I agree that my answers can be used for this research and that results may be published in "
                  "aggregated form, so that no individual can be identified."),
            ("5", "I understand that I can withdraw my submitted answers {withdraw_period} by sending the "
                  "reference code shown after I submit to the research team, and that after that they cannot "
                  "be removed.")]),
    Q("W7_quote", "single", "W7. Optional: quotations", hint="Optional. Your answer does not affect your participation.",
      options=[("yes", "Yes, short quotations from my written answers may be used in reports and publications, "
                       "with any identifying details removed"),
               ("no", "No, please do not quote my written answers")]),
    Q("W8_opendata", "single", "W8. Optional: open data",
      hint="Optional. Your answer does not affect your participation.",
      options=[("yes", "Yes, my answers (excluding written comments) may be included in an open research dataset "
                       "in a public repository such as Zenodo, once they have been anonymised and checked so "
                       "that no one can be identified"),
               ("no", "No, please use my answers only within the research team")]),
]
START_STEP = STEP("start", "Before you start", "bi-clipboard2-check",
                  "A few questions about how you came to the survey, then your consent.", W_ITEMS)


# ---------------------------------------------------------------------------
# Module A: common core (Section 5)
# ---------------------------------------------------------------------------
def module_a(pro):
    a10_opts = [
        ("funding", "Insufficient funding or investment"), ("costs", "Costs to households or businesses"),
        ("acceptance", "Public acceptance and behaviour change"), ("planning", "Planning and permitting delays"),
        ("grid", "Grid and infrastructure constraints"), ("enforcement", "Weak enforcement or monitoring"),
        ("conflicting", "Conflicting policies across sectors or departments"),
        ("technology", "Technology readiness or cost"), ("agri_economy", "Economic importance of agriculture"),
        ("skills", "Skills and workforce shortages"), ("governance", "Governance and coordination"),
        ("data", "Lack of data and evidence"), ("political", "Insufficient political commitment"),
        ("other", "Other (please specify)"), ("dk", "Don't know"),
    ]
    part1 = [
        Q("A1_familiarity", "scale", "A1. How familiar are you with Ireland's climate policies?", required=True,
          scale=FAMILIARITY),
        Q("A2_eff_overall", "scale", "A2. In your opinion, how effective have Ireland's climate policies been in "
          "reducing greenhouse gas emissions since the 1990s?", required=True, scale=EFFECTIVENESS, na=["dk"],
          hint="We are asking for your view, based on what you know. There are no right or wrong answers."),
        Q("A3_conf_overall", "scale", "A3. How confident are you in the answer you just gave?", scale=CONFIDENCE,
          show_if=[{"q": "A2_eff_overall", "ne": "dk"}]),
        Q("A4_basis", "multi", "A4. What mainly shapes your views on climate policy?", max=2, hint=UP_TO[2],
          options=[("personal", "Personal or household experience"), ("professional", "Professional experience"),
                   ("research", "Research or scientific literature"),
                   ("official", "Official reports (e.g. EPA, Climate Change Advisory Council)"),
                   ("news", "News media"), ("social", "Social media"),
                   ("conversations", "Conversations with other people"), ("dashboard", "This dashboard"),
                   ("other", "Other")]),
        Q("A5_target2030", "scale", "A5. Ireland has a legal target to cut its greenhouse gas emissions by 51% by "
          "2030, compared with 2018 (about half). In your view, how likely is Ireland to meet this target?",
          required=True, scale=LIKELIHOOD, na=["dk"]),
        Q("A6_pace", "single", "A6. Is the current pace of climate action in Ireland...", required=True,
          options=[("too_slow", "Too slow"), ("about_right", "About right"), ("too_fast", "Too fast"),
                   ("dk", "Don't know")]),
        Q("A7_eff_sector", "matrix", "A7. In your opinion, how effective has policy been in reducing emissions in "
          "each sector since the 1990s?", scale=EFFECTIVENESS, na=["dk"], rows=SECTORS, help=["lulucf"],
          hint="Answer each row. Choose \"Don't know\" for any sector you cannot judge."),
        Q("A8_trust_inventory", "scale", "A8. How much confidence do you have in the official figures for "
          "Ireland's greenhouse gas emissions?", scale=CONF_FIGURES, na=["dk"], help=["inventory"],
          hint="The official figures are the national greenhouse gas inventory, which the EPA compiles each year "
               "from data on activities such as fuel use, livestock numbers and fertiliser sales."),
        Q("A9_trust_govt", "scale", "A9. How much do you trust the Government to deliver on its climate "
          "commitments?", scale=TRUST, na=["dk"]),
    ]
    part2 = [
        Q("A10_barrier", "multi", "A10. What are the main barriers to more effective climate policy in Ireland?",
          max=3, exclusive=["dk"], other="other", options=a10_opts,
          hint="Choose up to three. \"Don't know\" cannot be combined with other answers."),
    ]
    if pro:
        part2.append(Q("A11_severity", "matrix", "A11. How serious is each barrier you chose in your sector or "
                       "area of work?", scale=SEVERITY, na=["cj"], rows=[o for o in a10_opts if o[0] not in
                                                                           ("other", "dk")],
                       rows_from={"q": "A10_barrier", "exclude": ["other", "dk"]},
                       hint="Only the barriers you chose in A10 are shown."))
    part2.append(Q("A12_incoherence", "scale", "A12. How often do you think government policies in areas such as "
                   "farming, housing, transport and energy pull in different directions?", scale=INCOHERENCE,
                   na=["dk"]))
    part3 = [
        Q("A13_fair_overall", "scale", "A13. How far do you agree? “Overall, the costs and benefits of "
          "climate policy in Ireland are shared fairly.”", scale=AGREEMENT, na=["dk"]),
        Q("A14_costs", "multi", "A14. Which groups, if any, carry the largest share of the costs of climate "
          "policy?", max=3, exclusive=["no_group", "dk"], options=COST_GROUPS, hint=UP_TO[3]),
        Q("A15_benefits", "multi", "A15. Which groups, if any, receive the largest share of the benefits of "
          "climate policy?", max=3, exclusive=["no_group", "dk"], options=COST_GROUPS, hint=UP_TO[3]),
        Q("A16_jt", "matrix", "A16. How far do you agree with each statement?", scale=AGREEMENT, na=["dk"],
          help=["just"], rows=[
              ("1", "People like me have a say in how climate policies are decided"),
              ("2", "Support is available for the people most affected by climate policies"),
              ("3", "Workers and communities that lose out (for example in peat or livestock farming) receive "
                    "adequate help to adapt"),
              ("4", "Climate policies put my own job or income at risk")]),
        Q("A17_strengthen", "multi", "A17. Which kinds of measures should be strengthened most?", max=3,
          exclusive=["dk"], hint=UP_TO[3], help=["ets", "just"], options=[
              ("carbon_tax", "Carbon tax and carbon pricing"), ("ets", "EU Emissions Trading System"),
              ("regulation", "Regulations and standards"),
              ("grants", "Grants and subsidies (e.g. retrofit, electric vehicles)"),
              ("infrastructure", "Public infrastructure (grid, public transport, cycling)"),
              ("agri_measures", "Agriculture and land-use measures"),
              ("renewables", "Renewable energy deployment"),
              ("just_transition", "Just transition and support for affected groups"),
              ("information", "Information and awareness"), ("innovation", "Research and innovation"),
              ("dk", "Don't know")]),
    ]
    intro = ("These questions are the same for everyone, so that answers can be compared between groups. We are "
             "asking for your views; there are no right or wrong answers. If you are not sure, please choose "
             "“Don't know”.")
    return [
        STEP("core1", "Your views", "bi-speedometer2", intro, part1),
        STEP("core2", "Barriers", "bi-cone-striped", "What holds climate policy back, and how often policies "
             "pull in different directions.", part2),
        STEP("core3", "Fairness", "bi-scales", "Who bears the costs, who benefits, and what should be "
             "strengthened.", part3),
    ]


# ---------------------------------------------------------------------------
# Module B: group modules (Section 6)
# ---------------------------------------------------------------------------
P_ITEMS_1 = [
    Q("P1_age", "single", "P1. Your age group", options=[
        ("18_24", "18–24"), ("25_34", "25–34"), ("35_49", "35–49"), ("50_64", "50–64"), ("65p", "65 or older"),
        ("pnts", "Prefer not to say")]),
    Q("P2_gender", "single", "P2. Your gender", other="self", options=[
        ("woman", "Woman"), ("man", "Man"), ("nonbinary", "Non-binary"), ("self", "Prefer to self-describe"),
        ("pnts", "Prefer not to say")]),
    Q("P3_region", "single", "P3. Where are you based?", options=REGIONS),
    Q("P4_urban_rural", "single", "P4. Do you live in...", options=[
        ("city", "A city"), ("town", "A town or village"), ("rural", "The countryside"),
        ("pnts", "Prefer not to say")]),
    Q("P5_education", "single", "P5. Your highest level of education completed", options=[
        ("lower_sec", "Lower secondary or less"), ("upper_sec", "Upper secondary (e.g. Leaving Certificate)"),
        ("further", "Further education, apprenticeship or post-Leaving Certificate course"),
        ("degree", "Third-level degree"), ("postgrad", "Postgraduate degree"), ("pnts", "Prefer not to say")]),
    Q("P6_tenure", "single", "P6. Which best describes your home?", options=[
        ("owned", "Owned (outright or with a mortgage)"), ("private_rent", "Rented privately"),
        ("social_rent", "Rented from a local authority or housing body"),
        ("family", "Living with family or others, not paying rent"), ("other", "Other"),
        ("pnts", "Prefer not to say")]),
    Q("P7_income_feel", "single", "P7. Which best describes how you feel about your household's income nowadays?",
      hint="This wording follows the European Social Survey, so answers can be compared with national figures.",
      options=[("comfortable", "Living comfortably"), ("coping", "Coping"), ("difficult", "Finding it difficult"),
               ("very_difficult", "Finding it very difficult"), ("pnts", "Prefer not to say")]),
]
P9_ROWS = [
    ("1", "The carbon tax on fuels (its revenue funds welfare supports, home retrofits and farming schemes)"),
    ("2", "Grants to insulate homes and install heat pumps"), ("3", "Incentives for electric cars"),
    ("4", "More frequent and cheaper public transport"), ("5", "Safer cycling and walking routes"),
    ("6", "More wind and solar farms"), ("7", "Voluntary payments to farmers who reduce livestock numbers"),
    ("8", "Restoring bogs and planting forests"),
]
P_ITEMS_2 = [
    Q("P8_concern", "scale", "P8. How concerned are you about climate change?", scale=CONCERN),
    Q("P9_support", "matrix", "P9. Do you support or oppose these measures?", scale=SUPPORT, na=["dk"], rows=P9_ROWS,
      hint="Each measure is described as it currently exists in Ireland or as it has been proposed."),
    Q("P10_action", "matrix", "P10. Have you done any of these in the last five years?", scale=ACTION, na=["na"],
      hint="Many emission cuts depend on government, businesses and infrastructure, not only on what individuals "
           "do. These questions are only about your own situation. Choose “Not applicable to me” if an "
           "action does not apply (for example, if you do not own a car).",
      rows=[("1", "Insulated or retrofitted my home"), ("2", "Installed a heat pump"),
            ("3", "Installed solar panels"), ("4", "Bought an electric or hybrid car"),
            ("5", "Used public transport more"), ("6", "Walked or cycled more"), ("7", "Flown less"),
            ("8", "Changed my diet")]),
    Q("P11_constraint", "multi", "P11. What makes it hardest for you to do more?", max=3, exclusive=["nothing"],
      other="other", hint="Choose up to three. “Nothing, I already do what I can” cannot be combined "
                          "with other answers.",
      options=[("upfront", "Upfront cost"), ("running", "Ongoing running costs"),
               ("renting", "I rent, or cannot change my home"),
               ("grants", "Grants are not available to me or are too complicated"),
               ("no_alternative", "No practical public transport or alternative where I live"),
               ("infrastructure", "Not enough charging points or other infrastructure"),
               ("information", "Not enough clear or trustworthy information"),
               ("tradespeople", "Hard to find reliable tradespeople or installers"),
               ("time", "Time and hassle"), ("health", "Health, disability or mobility"),
               ("not_convinced", "I'm not convinced it makes a difference"),
               ("nothing", "Nothing, I already do what I can"), ("other", "Other (please specify)")]),
    Q("P12_hh_impact", "scale", "P12. Overall, how have climate policies affected you and your household?",
      scale=IMPACT, na=["dk"]),
]

S_ITEMS_1 = [
    Q("S1_orgtype", "single", "S1. Which best describes your organisation?", required=True, other="other",
      hint="Please do not name your organisation.", options=[
          ("business", "Business or industry"), ("agri", "Farm or agri-food business"),
          ("energy", "Energy company or utility"), ("rep_body", "Trade association or representative body"),
          ("ngo", "Environmental NGO or civil society"), ("community", "Community group or co-operative"),
          ("union", "Trade union"), ("professional", "Professional body"), ("other", "Other (please specify)")]),
    Q("S2_relationship", "single", "S2. What is your main relationship to your sector?", options=[
        ("operational", "Operational role (e.g. farmer, site or plant manager)"),
        ("management", "Management or executive"), ("policy", "Policy, advocacy or public affairs"),
        ("technical", "Technical or advisory"), ("research", "Research or analysis"),
        ("representing", "Representing members or affected communities"), ("other", "Other")]),
    Q("S3_sector", "multi", "S3. Which sectors is your organisation active in?", required=True, max=3,
      hint=UP_TO[3], help=["lulucf"], options=SECTORS + [("cross", "Several sectors or cross-sector")]),
    Q("S3b_main_sector", "single", "S3b. Which one of these is your main sector?",
      options=SECTORS + [("cross", "Several sectors or cross-sector")], options_from={"q": "S3_sector"},
      show_if=[{"q": "S3_sector", "count_gt": 1}]),
    Q("S4_size", "single", "S4. Size of your organisation", options=[
        ("micro", "Fewer than 10 people"), ("small", "10–49"), ("medium", "50–249"), ("large", "250 or more"),
        ("na", "Not applicable")]),
    Q("S5_region", "single", "S5. Where is your organisation based?", options=REGIONS),
    Q("S6_perspective", "single", "S6. In this survey, are your answers...", options=PERSPECTIVE),
]
S_ITEMS_2 = [
    Q("S7_econ", "matrix", "S7. In your view, how has climate policy changed each of these over the last five years?",
      scale=CHANGE, na=["dkna"],
      hint="Answer for the organisation you work for. If you represent members (for example, as a trade "
           "association or union), answer for the members you represent. We are asking for your perception; you "
           "do not need financial figures.",
      rows=[("1", "Operating costs"), ("2", "Capital investment needs"),
            ("3", "Profitability or financial viability"), ("4", "New business or revenue opportunities"),
            ("5", "Competitiveness compared with other countries"), ("6", "Employment")]),
    Q("S8_sector_impact", "scale", "S8. Overall, what effect has climate policy had on your sector so far?",
      scale=IMPACT, na=["dk"]),
    Q("S9_stmt", "matrix", "S9. How far do you agree with these statements about your sector?", scale=AGREEMENT,
      na=["dk"], help=["inventory"], rows=[
          ("1", "The rules and targets are clear and stable enough to plan investment"),
          ("2", "Financial and technical support is adequate"), ("3", "Our sector has been properly consulted"),
          ("4", "Workers and communities in our sector are supported in the transition"),
          ("5", "Official emission estimates for our sector reflect the measures our sector has taken")]),
    Q("S10_agri_balance", "scale", "S10. How far do you agree? “Current agricultural climate policies strike a "
      "realistic balance between cutting emissions, food production and the economic viability of farms.”",
      scale=AGREEMENT, na=["dk"],
      show_if=[{"any": [{"q": "S3_sector", "has": "agriculture"}, {"q": "S1_orgtype", "eq": "agri"}]}]),
]

R_ITEMS_1 = [
    Q("R1_discipline", "single", "R1. Your main discipline", required=True, options=[
        ("atmospheric", "Atmospheric science"), ("env_science", "Environmental or climate science (other)"),
        ("economics", "Economics"), ("engineering", "Engineering or energy systems"),
        ("data_science", "Data science, statistics or computer science"),
        ("social", "Social or political science"), ("geography", "Geography or spatial science"),
        ("agri_science", "Agricultural, soil or land science"), ("health", "Public health"), ("other", "Other")]),
    Q("R2_career", "single", "R2. Career stage", options=[
        ("phd", "PhD researcher"), ("postdoc", "Postdoctoral researcher"),
        ("lecturer", "Lecturer or research fellow"), ("senior", "Senior lecturer or professor"),
        ("agency", "Researcher in a state agency or institute"), ("other", "Other")]),
    Q("R3_expertise", "multi", "R3. Your main areas of expertise", max=4, hint=UP_TO[4], help=["inverse", "lulucf"],
      options=[("monitoring", "Atmospheric greenhouse gas monitoring"),
               ("inventories", "Greenhouse gas emission inventories"),
               ("inverse", "Inverse modelling and top-down estimates"),
               ("remote", "Remote sensing and Earth observation"), ("agri", "Agricultural emissions"),
               ("lulucf", "Land use, soils and forestry (LULUCF)"), ("energy_models", "Energy-system modelling"),
               ("economics", "Climate or environmental economics"), ("econometrics", "Econometrics or statistics"),
               ("governance", "Environmental policy and governance"), ("social", "Social science and behaviour"),
               ("health", "Public health"), ("data", "Data science"), ("other", "Other")]),
    Q("R4_years", "single", "R4. How many years have you worked on climate, energy or environmental issues?",
      options=YEARS),
    Q("R5_policy_involvement", "multi", "R5. Have you been involved in any of these Irish climate-policy processes?",
      max=6, exclusive=["none"], hint="Choose all that apply. This is asked separately from your research expertise.",
      options=[("advisory", "Membership of an advisory or expert group"),
               ("commissioned", "Research commissioned by a government department or agency"),
               ("consultations", "Submissions to public consultations"),
               ("inventories", "Compiling inventories or projections"), ("other", "Other"),
               ("none", "None of these")]),
]
R_ITEMS_2 = [
    Q("R6_dataq", "matrix", "R6. How good are the data and evidence on policy impact in each sector?", scale=QUALITY,
      na=["ome"], rows=SECTORS, hint="Choose “Outside my expertise” for any sector you cannot assess."),
    Q("R7_attribution", "scale", "R7. How confident are you that changes in Ireland's emissions can be attributed "
      "to specific policies?", scale=CONFIDENCE, help=["attribution"]),
    Q("R8_gap", "multi", "R8. Where are the largest evidence gaps?", max=4, other="other", hint=UP_TO[4],
      help=["topdown", "attribution", "counterfactual"], options=[
          ("inventory_uncertainty", "Uncertainty in the national emission inventory"),
          ("bottomup_topdown", "Differences between bottom-up inventories and top-down (atmospheric) estimates"),
          ("monitoring", "Density or coverage of atmospheric monitoring"),
          ("resolution", "Spatial or sectoral resolution of emission data"),
          ("attribution", "Attributing emission changes to individual policies"),
          ("counterfactual", "Counterfactuals (what would have happened without the policy)"),
          ("ex_post", "Long-term ex-post evaluation of policies"), ("interaction", "Interactions between policies"),
          ("distribution", "Distributional effects on households and regions"),
          ("costs", "Costs and cost-effectiveness"), ("behaviour", "Behaviour and uptake"),
          ("agri_measurement", "Measuring agricultural emissions"), ("lulucf", "Land use and forestry accounting"),
          ("other", "Other (please specify)")]),
    Q("R9_method", "multi", "R9. Which methods should be used more to evaluate Irish climate policy?", max=3,
      help=["break", "inverse"],
      hint="Choose up to three. A structural break is a point where an emission trend changes direction or speed. "
           "Quasi-experimental designs compare similar groups or areas with and without a policy.",
      options=[("econometric", "Econometric and structural-break analysis"),
               ("quasi_exp", "Quasi-experimental designs"),
               ("models", "Energy-system and integrated assessment models"),
               ("inverse", "Atmospheric inverse modelling (top-down verification)"),
               ("lca", "Life-cycle assessment"), ("spatial", "Spatial and remote-sensing analysis"),
               ("qualitative", "Qualitative and process-tracing studies"), ("mixed", "Mixed methods"),
               ("other", "Other")]),
    Q("R10_data_access", "scale", "R10. How easy is it to access the official data you need for research?",
      scale=EASE, na=["dk"]),
    Q("R11_evidence_importance", "matrix", "R11. For evaluating Irish climate policy, how important is each of "
      "these sources of atmospheric and emissions evidence?", scale=IMPORTANCE, na=["ome"],
      help=["topdown", "insitu"], rows=[
          ("1", "Independent top-down verification of the national inventory, using atmospheric measurements and "
                "inverse models"),
          ("2", "Long-term in-situ greenhouse gas measurements (e.g. the ICOS-Ireland network, Mace Head)"),
          ("3", "Satellite observations of greenhouse gases (e.g. methane)"),
          ("4", "Spatially detailed (gridded) bottom-up emission maps")]),
]

E6_ROWS = [("1", "Offshore wind"), ("2", "Onshore wind and solar"), ("3", "Grid reinforcement and storage"),
           ("4", "Home retrofits and heat pumps"), ("5", "District heating"), ("6", "Electric vehicles and charging"),
           ("7", "Biomethane and anaerobic digestion"),
           ("8", "Low-emission farming practices (e.g. feed additives, slurry management)"),
           ("9", "Peatland rewetting"), ("10", "Afforestation")]
E_ITEMS_1 = [
    Q("E1_area", "multi", "E1. Your main areas of expertise", required=True, max=3, hint=UP_TO[3], help=["lulucf"],
      options=SECTORS + [("cross", "Climate policy in general (cross-sector)")]),
    Q("E2_workplace", "single", "E2. Where do you work?", options=[
        ("consultancy", "Consultancy"), ("industry", "Industry or industry body"),
        ("agency", "State agency or regulator"), ("ngo", "NGO (technical or policy role)"),
        ("academia", "University or research institute"), ("independent", "Independent or self-employed"),
        ("other", "Other")]),
    Q("E3_years", "single", "E3. How many years have you worked on climate, energy or environmental issues?",
      options=YEARS),
    Q("E4_perspective", "single", "E4. In this survey, are your answers...", options=PERSPECTIVE),
]
E_ITEMS_2 = [
    Q("E5_ambition", "matrix", "E5. Is the ambition of policy in each sector in line with what the 2030 target "
      "requires?", scale=AMBITION, na=["dk"], rows=SECTORS),
    Q("E6_deploy", "matrix", "E6. How close is actual deployment to the scale needed by 2030?", scale=PROGRESS,
      na=["ome"], rows=E6_ROWS,
      hint="This asks about actual deployment so far, not whether the technology is available."),
    Q("E7_feas", "pickgrid", "E7. Choose up to three of the technologies above that you know best, and rate the "
      "feasibility of reaching the scale needed by 2030 for each one.", max=3, options=E6_ROWS,
      scale=FEASIBILITY, na=["dk"], help=["institutional"],
      rows=[("1", "Technical feasibility (the technology works at the scale needed)"),
            ("2", "Economic feasibility (costs and financing can be met)"),
            ("3", "Institutional feasibility (regulation, planning and governance allow it)")]),
    Q("E8_constraint", "multi", "E8. What most constrains delivery?", max=3, other="other", hint=UP_TO[3], options=[
        ("grid", "Grid capacity and connection (capacity to connect new generation or demand)"),
        ("planning", "Planning and permitting (time and uncertainty of consents)"),
        ("regulation", "Regulation or regulatory uncertainty (rules, standards, market design)"),
        ("finance", "Access to finance (capital, cost of borrowing, investment risk)"),
        ("integration", "Technical integration (making new systems work with existing ones)"),
        ("land", "Land availability (suitable sites)"),
        ("skills", "Skilled workforce (installers, engineers, advisers)"),
        ("supply_chain", "Supply chains and equipment (availability and lead times)"),
        ("acceptance", "Public acceptance or local objection"), ("coordination", "Coordination between bodies"),
        ("other", "Other (please specify)")]),
]

M_ITEMS_1 = [
    Q("M1_workplace", "single", "M1. Where do you work?", required=True, hint="Please do not name your organisation.",
      options=[("department", "Government department"), ("agency", "State agency or regulator"),
               ("local", "Local authority"), ("regional", "Regional assembly or body"),
               ("elected", "Oireachtas or elected office"), ("eu", "EU or international institution"),
               ("other", "Other")]),
    Q("M2_role", "single", "M2. Your role", options=[
        ("elected", "Elected representative"), ("senior", "Senior official or manager"),
        ("officer", "Policy officer or analyst"), ("adviser", "Adviser"), ("other", "Other")]),
    Q("M3_area", "multi", "M3. Which policy areas do you work on?", max=3, hint=UP_TO[3], help=["lulucf"],
      options=SECTORS + [("cross", "Climate policy in general (cross-sector)")]),
    Q("M4_years", "single", "M4. How many years have you worked on climate, energy or environmental issues?",
      options=YEARS),
    Q("M5_perspective", "single", "M5. In this survey, are your answers...", options=PERSPECTIVE,
      hint="We ask for your own professional view. You do not need to represent the formal position of your "
           "organisation."),
    Q("M5b_knowledge_basis", "single", "M5b. Your answers to the next three questions (M6–M8) are based mainly "
      "on...", options=[("direct", "Direct involvement in the processes described"),
                        ("formal", "Formal knowledge of them through my role, without direct involvement"),
                        ("general", "General knowledge or personal opinion")]),
]
M_ITEMS_2 = [
    Q("M6_gov", "matrix", "M6. How far do you agree with these statements?", scale=AGREEMENT, na=["dk"],
      help=["ceiling"], rows=[
          ("1", "Policies across government departments are coherent"),
          ("2", "Carbon budgets and sectoral ceilings effectively guide decisions"),
          ("3", "Implementing bodies have enough staff and funding"),
          ("4", "Monitoring shows clearly whether measures are working"),
          ("5", "Local authorities have the powers they need to deliver"),
          ("6", "Public engagement is sufficient to build acceptance"),
          ("7", "Independent atmospheric measurements are used to check national emission estimates")]),
    Q("M7_evid_use", "matrix", "M7. In your area of work, how often is independent scientific evidence used at each "
      "stage of policy?", scale=FREQUENCY, na=["dk"],
      hint="Think of the administrative level you work at (M1) and your main policy areas (M3).",
      rows=[("1", "Developing new policies"), ("2", "Implementing policies"), ("3", "Evaluating existing policies")]),
    Q("M8_evid_limit", "multi", "M8. What most limits the use of scientific evidence in your area?", max=3,
      exclusive=["nothing"], other="other",
      hint="Choose up to three. “Nothing significant” cannot be combined with other answers.",
      options=[("not_available", "Relevant data are not available"), ("not_timely", "Data or evidence are not timely"),
               ("format", "Evidence is not in a usable format"),
               ("capacity", "Limited analytical capacity in my organisation"),
               ("links", "Weak links between research and government"),
               ("political", "Political or institutional constraints"), ("funding", "Funding"),
               ("priorities", "Competing priorities"), ("conflicting", "Conflicting evidence"),
               ("nothing", "Nothing significant"), ("other", "Other (please specify)")]),
    Q("M9_evid_need", "multi", "M9. Which evidence would most improve policy decisions?", max=3, hint=UP_TO[3],
      help=["topdown", "abatement"], options=[
          ("ex_ante", "Ex-ante appraisal of new measures"), ("ex_post", "Ex-post evaluation of existing policies"),
          ("projections", "Sectoral emission projections"),
          ("verification", "Independent atmospheric verification of emissions"),
          ("distribution", "Distributional and social impacts"), ("local", "Local and spatial data"),
          ("international", "International comparisons"),
          ("macc", "Abatement costs (marginal abatement cost curves)"), ("behaviour", "Behavioural insights")]),
]

MODULE_B = {
    "public": [
        STEP("profile", "About you", "bi-person", "A few questions about you and how climate action fits into your "
             "life. Nothing here identifies you.", P_ITEMS_1),
        STEP("everyday", "Your life", "bi-house-heart", "Your views on measures, and climate action in your own "
             "life.", P_ITEMS_2),
    ],
    "stakeholder": [
        STEP("profile", "Your organisation", "bi-building", "About the organisation or sector you speak for. Please "
             "do not name your organisation.", S_ITEMS_1),
        STEP("sector", "Your sector", "bi-diagram-3", "How climate policy affects the organisations and people you "
             "work for or represent.", S_ITEMS_2),
    ],
    "researcher": [
        STEP("profile", "Your research", "bi-mortarboard", "About your research background.", R_ITEMS_1),
        STEP("evidence", "Evidence", "bi-clipboard-data", "How well we can tell whether Irish climate policies "
             "work.", R_ITEMS_2),
    ],
    "expert": [
        STEP("profile", "Your expertise", "bi-tools", "About your professional expertise.", E_ITEMS_1),
        STEP("delivery", "Delivery", "bi-lightning-charge", "Whether key measures are being delivered at the scale "
             "needed.", E_ITEMS_2),
    ],
    "policymaker": [
        STEP("profile", "Your role", "bi-bank", "About your role and how the system for making and delivering climate "
             "policy works. We ask for your own professional view.", M_ITEMS_1),
        STEP("governance", "Governance", "bi-diagram-2", "How the system for making and delivering climate policy "
             "works, and how evidence is used.", M_ITEMS_2),
    ],
}

# ---------------------------------------------------------------------------
# Module G (public, Form A) and Module I (Sections 7 and 8)
# ---------------------------------------------------------------------------
G_ROWS = [("1", "The carbon tax on fuels"), ("2", "Grants to insulate homes and install heat pumps"),
          ("3", "More wind and solar farms"), ("4", "Voluntary payments to farmers who reduce livestock numbers")]
FORM_A = [{"form": "A"}]
G_ITEMS = [
    Q("G1_eff", "matrix", "G1. How much do you think each measure would reduce Ireland's greenhouse gas emissions?",
      scale=REDUCTION, na=["dk"], rows=G_ROWS, show_if=FORM_A, hint="These are four of the measures you rated in P9."),
    Q("G2_fair", "matrix", "G2. How fair do you think each measure is to people in Ireland?", scale=FAIRNESS,
      na=["cj"], rows=G_ROWS, show_if=FORM_A),
    Q("G3_cost", "matrix", "G3. How would each measure affect your own household's costs?", scale=HH_COST, na=["dk"],
      rows=G_ROWS, show_if=FORM_A),
]
I1 = Q("I1_int", "matrix", "I1. For each pair of policies, how does the first affect the ability to achieve the "
       "second?", scale=INTERACTION, na=["cj"], randomize=True, help=["interaction", "ceiling"],
       hint="Use the scale from −3 (achieving the first makes the second impossible) to +3 (the two cannot be "
            "achieved separately). 0 means the first has no significant effect on the second. Choose “Cannot "
            "judge” for any pair outside your knowledge.",
       rows=[("1", "Agri-food growth strategy (Food Vision 2030) → Agriculture sectoral emissions ceiling"),
             ("2", "Policy supporting data-centre development → Electricity sectoral emissions ceiling"),
             ("3", "Afforestation targets (Forestry Programme) → Farm income and land-use supports (CAP "
                   "Strategic Plan)"),
             ("4", "Home retrofit programme (National Retrofit Plan) → Housing supply targets (Housing for All)"),
             ("5", "Renewable electricity target (80% by 2030) → Planning and consenting system"),
             ("6", "Carbon tax increases → Energy cost-of-living supports (e.g. electricity credits)")])
I2 = Q("I2_conflict_open", "text", "I2. Are there two Irish policies that you think work against each other? If so, "
       "name them and briefly say why.", max_len=600,
       hint="Optional. A sentence or two is enough (up to 600 characters).")

# ---------------------------------------------------------------------------
# Module C: policy evaluation (Section 9)
# ---------------------------------------------------------------------------
REFERENCE_POLICIES = [
    {"code": "carbon_tax", "title": "Carbon Tax", "timeline": "Carbon Tax (Finance Act 2010)", "level": "National",
     "lead": "Rate set in the annual Budget and Finance Act (Department of Finance)",
     "period": "From its introduction (2010; it applied to transport fuels from December 2009) to the latest year "
               "shown in the dashboard",
     "desc": "A tax on the carbon dioxide emitted when fossil fuels such as petrol, diesel, home heating oil, gas and "
             "coal are burned. It was introduced in 2010, and its rate is set in each year's Budget.",
     "link": "/#policy/policies/irl-p0005--transport/", "exclude_prefix": "Carbon Tax"},
    {"code": "cap", "title": "Climate Action Plan", "timeline": "Climate Action Plan 2019", "level": "National",
     "lead": "Prepared by the Department of Climate, Energy and the Environment with all departments; approved by "
             "Government",
     "period": "From 2019 to the latest year shown in the dashboard (the framework across its editions)",
     "desc": "The Government's plan for meeting Ireland's climate targets, first published in 2019 and updated each "
             "year. It sets out actions for each sector of the economy, and recent editions set emission ceilings "
             "for each sector.",
     "link": "/#policy/timeline/", "exclude_prefix": "Climate Action Plan"},
]
C_BASIS = [("personal", "Direct personal experience"), ("professional", "Professional experience"),
           ("organisational", "Organisational experience"), ("research", "Research or scientific evidence"),
           ("official", "Official reports or evaluations"), ("media", "General knowledge or the media"),
           ("dashboard", "Information in this dashboard"), ("other", "Other")]
C10 = {
    "public": ("C10_acc", "Acceptability", "How acceptable is this policy to you?", ACCEPTABILITY, ["cj"]),
    "stakeholder": ("C10_work", "Workability", "How workable is this policy for the organisations you work for or "
                    "represent?", WORKABILITY, ["cj"]),
    "researcher": ("C10_rob", "Robustness of evaluation", "How robust are the methods that have been used to evaluate "
                   "this policy?", EVIDENCE, ["ii"]),
    "expert": ("C10_des", "Technical design", "How would you rate the technical design of this policy for what it "
               "has to achieve?", DESIGN, ["cj"]),
    "policymaker": ("C10_inst", "Institutional feasibility", "How feasible is it for the responsible bodies to deliver "
                    "this policy, given their powers, staff and funding?", FEASIBILITY, ["ii"]),
}


def module_c(group):
    """The per-policy items of Module C for one group (C9 is not shown to the public; C10 depends on the group)."""
    v10, crit, label10, scale10, na10 = C10[group]
    items = [
        Q("fam", "scale", "C1. How familiar are you with this policy?", required=True, scale=FAMILIARITY,
          var="C1_fam", hint="If you choose “Not at all familiar”, the remaining questions for this policy "
                             "are skipped."),
        Q("basis", "multi", "C2. What is your assessment mainly based on?", max=8, options=C_BASIS, var="C2_basis",
          hint="Choose all that apply."),
        Q("viewed", "multi", "C3. Before answering, did you look at this policy in the dashboard?", max=2,
          exclusive=["no"], var="C3_viewed",
          options=[("profile", "Yes, its policy profile"),
                   ("trend", "Yes, the emission trend or structural-break results around it"), ("no", "No")]),
        Q("obs", "scale", "C4. Past contribution. In your opinion, to what extent has this policy contributed to "
          "reducing greenhouse gas emissions in Ireland so far?", scale=EXTENT, na=["tea", "cj"], var="C4_obs_eff",
          hint="Please give your assessment based on your knowledge or experience. This question records your "
               "judgement; it is not asking you to calculate or prove the policy's causal effect. “So far” "
               "means from the start of the assessment period shown for this policy to today."),
        Q("exp", "scale", "C5. Expected contribution. To what extent do you expect this policy, as currently designed "
          "and implemented, to contribute to reducing Ireland's greenhouse gas emissions by 2030?", scale=EXTENT,
          na=["cj"], var="C5_exp_eff"),
        Q("impl", "scale", "C6. Implementation. To what extent has this policy been implemented as intended?",
          scale=EXTENT, na=["tea", "cj"], var="C6_impl"),
        Q("fair", "scale", "C7. Fairness. In your view, how fairly are the costs and benefits of this policy "
          "distributed across different groups in Ireland?", scale=FAIRNESS, na=["cj"], var="C7_fair"),
        Q("evid", "scale", "C8. Evidence. Based on the information you know, how strong do you think the available "
          "evidence is for assessing whether this policy has achieved its intended emissions-related outcomes?",
          scale=EVIDENCE, na=["ii"], var="C8_evid",
          hint="Choose “Insufficient information” if you do not know enough to judge. This is different "
               "from “Very weak”: not having information does not mean the policy has failed."),
    ]
    if group in PRO_GROUPS:
        items.append(Q("cost", "scale", "C9. Value for cost. Overall, how would you rate the value achieved by this "
                       "policy relative to the public and private costs involved?", scale=VALUE, na=["ii", "cj"],
                       var="C9_costeff"))
    items += [
        Q("grp", "scale", f"C10. {crit}. {label10}", scale=scale10, na=na10, var=v10,
          help=["institutional"] if v10 == "C10_inst" else None),
        Q("conf", "scale", "C11. How confident are you in your assessment of this policy?", scale=CONFIDENCE,
          var="C11_conf"),
        Q("comment", "text", "C12. Please briefly explain the main reason for your assessment. Where possible, "
          "mention the evidence, experience or implementation issue behind your judgement.", max_len=400,
          var="C12_comment",
          hint="Optional. One or two sentences (up to 400 characters). Please do not include names or details that "
               "could identify you or others."),
    ]
    for it in items:
        if not it.get("help"):
            it.pop("help", None)
    return Q("C_policies", "policies3", "Module C: policy evaluation", refs=REFERENCE_POLICIES, items=items,
             own_label="One policy of your own choice",
             own_hint="Choose one policy you know from the dashboard's policy timeline. You can search it and "
                      "filter it by level. The two policies above cannot be chosen again.")


# ---------------------------------------------------------------------------
# Module K: information, knowledge and arguments (Section 10)
# ---------------------------------------------------------------------------
K1 = Q("K1_trust_src", "matrix", "K1. How much do you trust each of these as a source of information about climate "
       "policy?", scale=TRUST, na=["dk"], rows=[
           ("1", "Environmental Protection Agency (EPA)"), ("2", "Government departments"),
           ("3", "Climate Change Advisory Council"), ("4", "University scientists"), ("5", "Farm organisations"),
           ("6", "Environmental organisations (NGOs)"), ("7", "Energy companies"),
           ("8", "Newspapers, television and radio"), ("9", "Social media"), ("10", "Friends and family")])
K2_ROWS = [
    ("1", "Agriculture is the largest single source of Ireland's greenhouse gas emissions"),
    ("2", "Ireland's greenhouse gas emissions have fallen every year since 2018"),
    ("3", "Most of Ireland's electricity now comes from renewable sources"),
    ("4", "Money raised by the carbon tax is used to fund welfare supports, home energy upgrades and farming schemes"),
    ("5", "Heat pumps only work in new houses"),
    ("6", "Over their lifetime, electric cars in Ireland produce more greenhouse gases than petrol or diesel cars"),
]
K2 = Q("K2_tf", "matrix", "K2. Do you think each statement is true or false?", scale=TRUE_FALSE, na=["ns"],
       rows=K2_ROWS, randomize=True, show_if=[{"form": "B"}],
       hint="Please answer without looking anything up. If you are not sure, choose “Not sure”. The "
            "correct answers, with sources, are shown at the end of the survey.")
K3 = Q("K3_delay", "matrix", "K3. How far do you agree with each of these statements, which are often heard in "
       "debates about climate policy?", scale=AGREEMENT, na=["dk"], rows=[
           ("1", "Ireland's emissions are too small to make a difference globally"),
           ("2", "Ireland should wait for bigger emitters, such as China and the United States, to act first"),
           ("3", "New technology will solve climate change without changes to how we live or farm"),
           ("4", "Climate policies will do more harm than good to rural communities"),
           ("5", "It is too late for climate policies to make a real difference")])
# K2 answer key (Section 10.1): true = 1/2 is correct ("true"), 3/4 correct for "false"
K2_KEY = [
    ("1", True, "Agriculture was the largest single source, at about 38% of national emissions in 2024.",
     "EPA, Ireland's greenhouse gas emissions 1990–2024"),
    ("2", False, "Emissions rose by 4.7% in 2021, as Covid-19 restrictions eased. They have fallen in each year since "
                 "then.", "EPA, provisional greenhouse gas emissions 1990–2021 and 1990–2024"),
    ("3", False, "Renewables supplied about 41% of Ireland's electricity in 2024. The 2030 target is 80%.",
     "SEAI, Energy in Ireland (2025 edition)"),
    ("4", True, "Since 2020 the additional carbon tax revenue from each year's rate increase is allocated by law to "
                "social-welfare and fuel-poverty measures, home energy-efficiency (retrofit) schemes and "
                "agri-environment schemes for farmers.",
     "Finance Act 2020 and the annual Budget documents, Department of Finance"),
    ("5", False, "Heat pumps work well in existing and older homes once heat loss is low enough, which insulation and "
                 "airtightness upgrades achieve. SEAI grants for heat pumps are available for homes built before "
                 "2021 that meet its heat-loss test.", "SEAI, heat pump systems and the Heat Pump Grant"),
    ("6", False, "Life-cycle studies find lower lifetime greenhouse gas emissions for electric cars than for petrol or "
                 "diesel cars, battery production included, and the gap grows as more electricity comes from "
                 "renewables.",
     "European Environment Agency, Electric vehicles from life cycle and circular economy perspectives (2018); "
     "ICCT, A global comparison of the life-cycle greenhouse gas emissions of combustion engine and electric "
     "passenger cars (2021)"),
]
DEBRIEF = {
    "intro": "Thank you. Some questions in this survey asked whether statements about climate policy were true or "
             "false. Here are the correct answers, with their sources.",
    "general": "We also asked about some arguments that are often made in debates about climate policy. People "
               "disagree about several of these, and some depend on values as well as facts. If you would like to "
               "read more, the EPA (www.epa.ie) and the Climate Change Advisory Council (www.climatecouncil.ie) "
               "publish independent information on Ireland's emissions and climate policy.",
}

# ---------------------------------------------------------------------------
# Module D: dashboard evaluation, and Module F: final questions (Section 11)
# ---------------------------------------------------------------------------
D1_OPTS = [("explorer", "Explorer Dashboard (home page)"), ("policy", "Policy Timeline"),
           ("mapping", "Spatial Mapping"), ("trend", "Trend Analysis"), ("sba", "Structural Break Analysis app"),
           ("datasets", "Datasets (Data Catalogue)"), ("guide", "User Guide or video tutorials"),
           ("none", "None of these")]
USED = [{"q": "D1_used", "not_has": "none"}]
D10 = {"public": "for understanding climate policy", "stakeholder": "for your organisation",
       "researcher": "for research", "expert": "for your professional work", "policymaker": "for policy decisions"}
F2 = {"public": "Is there anything about how climate policy affects you or your community that this survey has not "
                "asked about?",
      "stakeholder": "What support would most help your sector cut its emissions?",
      "researcher": "Which research question on Irish climate policy most needs answering?",
      "expert": "What one change would most speed up delivery in your area?",
      "policymaker": "What evidence or tool would most help your work on climate policy?"}
OPEN_HINT = "Optional. A sentence or two is enough (up to 1,500 characters)."


def module_d(group):
    pro = group in PRO_GROUPS
    qs = [
        Q("D1_used", "multi", "D1. Which parts of the dashboard did you use today?", max=8, exclusive=["none"],
          options=D1_OPTS, help=["break"],
          hint="Choose all that apply. “None of these” cannot be combined with other answers."),
        Q("D2_umux1", "scale", "D2. “The dashboard's capabilities meet my requirements.”", scale=UMUX,
          show_if=USED),
        Q("D3_umux2", "scale", "D3. “The dashboard is easy to use.”", scale=UMUX, show_if=USED),
        Q("D4_useful", "matrix", "D4. How useful was each part you used?", scale=USEFULNESS,
          rows=[o for o in D1_OPTS if o[0] != "none"], rows_from={"q": "D1_used", "exclude": ["none"]},
          show_if=USED, hint="Only the parts chosen in D1 are shown."),
        Q("D5_clarity_policy", "scale", "D5. How clearly does the dashboard show how climate policies line up with "
          "changes in emissions?", scale=CLARITY, show_if=USED),
    ]
    if pro:
        qs.append(Q("D6_clarity_topdown", "scale", "D6. How clearly does the dashboard show differences between "
                    "inventory estimates and estimates based on atmospheric measurements?", scale=CLARITY,
                    show_if=[{"q": "D1_used", "has": "mapping"}],
                    hint="For example, in Spatial Mapping, when comparing MapEIre or EDGAR maps with inverse-model "
                         "maps."))
    qs += [
        Q("D7_clarity_uncert", "scale", "D7. How clearly does the dashboard explain the limitations and uncertainties "
          "of the data?", scale=CLARITY, show_if=USED),
        Q("D8_comprehension", "single", "D8. On the dashboard, a sector's emission trend changes in the same year that "
          "a policy was introduced. Which statement best describes what this shows?", show_if=USED,
          randomize_first=3, hint="Please answer without looking it up.",
          options=[("caused", "The policy caused the change in emissions"),
                   ("same_time", "The policy and the change happened at the same time; other evidence is needed to "
                                 "show the policy caused it"),
                   ("no_effect", "The policy had no effect on emissions"), ("ns", "Not sure")]),
        Q("D9_new_questions", "single", "D9. Did the dashboard help you identify new questions or gaps in knowledge "
          "about Irish climate policy?", show_if=USED,
          options=[("several", "Yes, several"), ("one_two", "Yes, one or two"), ("no", "No"), ("ns", "Not sure")]),
        Q("D10_useful_role", "scale", f"D10. How useful is this dashboard {D10[group]}?", scale=USEFULNESS),
    ]
    if pro:
        qs.append(Q("D11_needs", "multi", "D11. Which of these would make the platform more useful for your work?",
                    max=8, other="other", hint="Choose all that apply.", options=[
                        ("downloads", "Data downloads in open formats"), ("methods", "Fully documented methods"),
                        ("doi", "Version-stamped datasets with DOIs, for citation"),
                        ("api", "Programmatic (API) access"), ("uncertainty", "Uncertainty ranges shown on all estimates"),
                        ("code", "Access to analysis code"), ("local", "More sub-national or county-level data"),
                        ("other", "Other (please specify)")]))
    qs.append(Q("D12_improve", "text", "D12. What additional information or functionality would make the platform "
                "more useful?", max_len=1500, hint=OPEN_HINT))
    return STEP("dashboard", "This dashboard", "bi-window-desktop",
                "Now some questions about this platform. Your answers will help us improve it.", qs)


def module_f(group):
    return STEP("final", "Final questions", "bi-chat-square-quote", "Last questions. Everything here is optional.", [
        Q("F1_change", "text", "F1. What single change would most improve Ireland's climate policy?", max_len=1500,
          hint=OPEN_HINT),
        Q("F2_group_open", "text", f"F2. {F2[group]}", max_len=1500, hint=OPEN_HINT),
        Q("F3_other", "text", "F3. Any other comments on climate policy, on this survey or on the evidence shown in "
          "the dashboard?", max_len=1500, hint=OPEN_HINT),
        Q("F4_survey_feedback", "text", "F4. Was anything in this questionnaire unclear, difficult to answer or "
          "missing?", max_len=1500, hint=OPEN_HINT),
    ])


# ---------------------------------------------------------------------------
# One questionnaire per group, in the order of Section 2.4
# ---------------------------------------------------------------------------
WELCOME = STEP("welcome", "Welcome", "bi-clipboard2-check", "", [W1])


def _flow(group):
    pro = group in PRO_GROUPS
    steps = [copy.deepcopy(START_STEP)] + module_a(pro) + copy.deepcopy(MODULE_B[group])
    inter = ([] if not pro else [I1]) + [I2]
    if group == "public":
        steps.append(STEP("support", "Four measures", "bi-hand-thumbs-up", "Now some questions about four of the "
                          "measures you have just rated.", copy.deepcopy(G_ITEMS)))
    steps.append(STEP("interactions", "Policy interactions", "bi-arrow-left-right",
                      "Some policies help each other; others pull in different directions." +
                      (" We would like your view on six pairs of Irish policies." if pro else ""),
                      copy.deepcopy(inter)))
    steps.append(STEP("policies", "Policies", "bi-journal-check",
                      "For each policy, please tell us how well you know it, and then what you think of it. If a "
                      "policy is recent and its effects cannot yet be seen, choose “Too early to assess”.",
                      [module_c(group)]))
    steps.append(STEP("information", "Information", "bi-newspaper",
                      "Finally, some questions about information on climate policy and about statements often heard "
                      "in public debate.", copy.deepcopy([K1] + ([K2] if group == "public" else []) + [K3])))
    steps.append(module_d(group))
    steps.append(module_f(group))
    return steps


FLOWS = {g: _flow(g) for g in GROUP_CODES}


# ---------------------------------------------------------------------------
# Routing (Section 13.1): the same rules run in the browser (survey.js)
# ---------------------------------------------------------------------------
def _cond(c, answers, form):
    if "any" in c:
        return any(_cond(x, answers, form) for x in c["any"])
    if "form" in c:
        return form == c["form"]
    v = answers.get(c["q"])
    if "ne" in c:
        return v != c["ne"]
    if "eq" in c:
        return v == c["eq"]
    if "has" in c:
        return isinstance(v, list) and c["has"] in v
    if "not_has" in c:
        return not (isinstance(v, list) and c["not_has"] in v)
    if "count_gt" in c:
        return isinstance(v, list) and len(v) > c["count_gt"]
    return True


def visible(q, answers, form=None) -> bool:
    """Whether question ``q`` is shown, given the answers so far (and the public form)."""
    if not all(_cond(c, answers, form) for c in q.get("show_if", [])):
        return False
    if q.get("rows_from"):
        return bool(dynamic_rows(q, answers))
    return True


def dynamic_rows(q, answers):
    """Rows of a grid, limited to the options chosen in an earlier question when ``rows_from`` is set."""
    rf = q.get("rows_from")
    if not rf:
        return q["rows"]
    chosen = answers.get(rf["q"]) or []
    return [r for r in q["rows"] if r[0] in chosen and r[0] not in rf.get("exclude", [])]


def options_for(q, answers, group=None):
    """Options shown for a choice question (W2 leaves out the W1 group; S3b lists the sectors chosen in S3)."""
    opts = q.get("options", [])
    if q.get("exclude_group") and group:
        opts = [o for o in opts if o[0] != group]
    if q.get("options_from"):
        chosen = answers.get(q["options_from"]["q"]) or []
        opts = [o for o in opts if o[0] in chosen]
    return opts


# ---------------------------------------------------------------------------
# Access and the browser schema
# ---------------------------------------------------------------------------
def group_label(code: str) -> str:
    return next((g[1] for g in GROUPS if g[0] == code), code)


def fill(text: str) -> str:
    """Put the values of CONFIRM into a text with {placeholders}."""
    try:
        return text.format(**CONFIRM)
    except (KeyError, IndexError, ValueError):
        return text


def _opts(pairs):
    return [{"code": c, "label": fill(l)} for c, l in pairs]


def _scale_json(s):
    return {"min": s["min"], "max": s["max"], "labels": {str(k): v for k, v in s["labels"].items()},
            "ends_only": s.get("ends_only", False)}


def _q_json(q):
    out = {k: v for k, v in q.items() if k not in ("options", "rows", "scale", "items", "na", "label", "hint")}
    out["label"] = fill(q["label"])
    if q.get("hint"):
        out["hint"] = fill(q["hint"])
    for key in ("options", "rows"):
        if key in q:
            out[key] = _opts(q[key])
    if "scale" in q:
        out["scale"] = _scale_json(q["scale"])
    if q.get("na"):
        out["na"] = [{"code": c, "label": NS[c]} for c in q["na"]]
    if "items" in q:
        out["items"] = [_q_json(i) for i in q["items"]]
    return out


def _step_json(step):
    return {**{k: v for k, v in step.items() if k != "questions"}, "questions": [_q_json(q) for q in step["questions"]]}


def public_schema() -> dict:
    """The questionnaire as JSON for the browser (no keys: those stay on the server)."""
    return {
        "version": SURVEY_VERSION, "title": SURVEY_TITLE,
        "groups": [{"code": c, "label": l, "plural": p, "icon": i, "desc": d, "minutes": m, "keyed": k}
                   for c, l, p, i, d, m, k, _ in GROUPS],
        "info": {sec: [[t, fill(x)] for t, x in items] for sec, items in INFO.items()},
        "access_note": ACCESS_NOTE,
        "help": {k: {"term": t, "text": x} for k, (t, x) in HELP.items()},
        "welcome": _step_json(WELCOME),
        "flows": {g: [_step_json(s) for s in steps] for g, steps in FLOWS.items()},
        "k2_key": [{"row": r, "true": t, "text": x, "source": s} for r, t, x, s in K2_KEY],
        "debrief": DEBRIEF,
        "confirm": CONFIRM,
    }


def questions(group: str | None = None):
    """(step id, question) for one group's questionnaire, welcome page included, in order."""
    for q in WELCOME["questions"]:
        yield WELCOME["id"], q
    for step in FLOWS.get(group, []):
        for q in step["questions"]:
            yield step["id"], q


def variables():
    """Every question once, in questionnaire order: (step id, question, [groups], [wordings])."""
    seen = {}
    for g in GROUP_CODES:
        for step_id, q in questions(g):
            if q["id"] not in seen:
                seen[q["id"]] = [step_id, q, [], []]
            v = seen[q["id"]]
            if g not in v[2]:
                v[2].append(g)
            if q["label"] not in v[3]:
                v[3].append(q["label"])
    return [tuple(v) for v in seen.values()]
