# Guided tours: how to edit them

All tours live in **`explorer/static/explorer/tour/tour.js`**, in the `TOURS` object near the top of the file
(`TOURS["mapping-timeseries"]` and `TOURS["dashboard"]`). The text in the User Guide's
3.1 "Worked example, step by step" list is built from the same steps, so editing a step here
updates both the tour and the guide.

## A step

```js
{
  id: "year",                                  // unique within the tour
  phase: "Select the data",                    // shown in the card's top line
  where: "map",                                // "map" = inside Spatial Mapping, "page" = the dashboard
  title: "Step 2 · Select the layer: year",    // card heading (HTML allowed)
  summary: "…",                                // optional: one line for the User Guide list
  text: `<p>…</p>`,                            // the explanation (HTML)
  tip: `…`,                                    // optional: teal hint box
  warn: `…`,                                   // optional: amber caution box
  target: c => c.q("#rasterYear").closest(".raster-field"),   // what is highlighted
  place: "right",                              // preferred side of the card
  prepare: c => c.openStep("msStep2Btn"),      // runs before the step (opens a panel section)
  task: "Set Year to 2019.",                   // what the user should do
  done: c => c.q("#rasterYear").value === "2019",            // ticks the task when true
  auto: c => c.select("#rasterYear", "2019")   // what "Do it for me" does
}
```

Only `id`, `phase`, `title` and `text` are required. Without `target` the card is centred;
without `task`/`done` there is nothing to tick; without `auto` there is no "Do it for me" button.
Add `noReplay: true` to steps that download a file, so they are not repeated when a tour is
started part-way through from the User Guide.

## Common edits

| To… | Do this |
|---|---|
| Change wording | Edit `title`, `text`, `tip`, `warn`, `task` or `summary`. |
| Change the example (e.g. another year, sector or county) | Change the value in both `done` and `auto` of that step, and the wording. Values are the option **values** of the drop-down (e.g. `K_AgriLivestock`, `CH4`, `Dublin`); the visible labels also work. |
| Remove a step | Delete its `{ … },` block. |
| Add a step | Copy a similar step, give it a new `id`, change the target and text. |
| Reorder | Move the blocks. Keep the order the dashboard needs (a layer must be chosen before it can be plotted). |

### Helpers available as `c` in `target`, `prepare`, `done` and `auto`

* `c.q(selector)`: an element in the Spatial Mapping workspace; `c.page(selector)`: in the dashboard
* `c.openStep(buttonId)`: open a numbered section of the map's left panel (`msStep1Btn`, `msStep2Btn`,
  `msStepAreaBtn`, `msStepAddBtn`, `msStep3Btn` Map style, `msStep4Btn` Download, `msAboutBtn`)
* `c.click(selector)`, `c.select(selector, value)`: act on a control once it is ready
* `c.pressed(selector)`: true when a button/tab/radio is selected
* `c.wait(fn, ms)`, `c.sleep(ms)`

To find a control's selector: right-click it in Chrome → **Inspect**, and use its `id`
(e.g. `#tsAdd`), or record the action with Playwright as before and reuse the names it shows.

## Auto-play

The **Auto-play** button on the tour card (and on the User Guide and *Guided tours* launchers, via
`data-tour-autoplay`) runs the rest of the tour by itself. For each step it waits **Delay** seconds
(1 s by default, 1–30 s, remembered in the browser), performs the step's `auto` action if the step is
not already `done`, waits **Delay** again, then moves to the next step, until the last card.

* Steps without `auto` are only shown for the delay.
* Steps with `noReplay: true` (downloads) are skipped unless **Include downloads** is ticked.
* Pressing **Pause**, Back, Next, Do it for me or Esc stops it; an error message stops it too.
* From the console: `inpactTour.start("mapping-timeseries", 0, { autoplay: true })`.

So a new step works with Auto-play as long as its `auto` action really completes the task.

## Things to know

* **Time series is a switch.** It is on when Spatial Mapping opens; clicking it again closes the
  analysis and its panel. The time-series tour has `requireTs: true`, so it switches the analysis
  back on if a user closes it. Keep that line when you copy this tour for another time-series topic.
* After editing, bump the version in `explorer/page/index.html`
  (`tour.js?v=…` and `tour.css?v=…`), otherwise browsers keep the old file.
* Test locally, then deploy: commit, push, and
  `ssh inpact-aws 'cd ~/INPACT_AWS && bash deploy/update.sh'`.
* Quick check: open the browser console and run `inpactTour.start("mapping-timeseries", 5)`
  to jump to step 6 (steps count from 0).
