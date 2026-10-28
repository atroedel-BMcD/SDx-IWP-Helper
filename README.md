# SDX IWP Helper

A Tampermonkey userscript for SDx work packages (IWPs). It bulk creates IWPs from a CSV, associates drawing lists with existing IWPs, highlights packages with superseded documents, downloads stamped PDF drawings as ZIP files, and helps replace superseded document associations with current revisions.

The current userscript version is **0.10.2**. The script is in [SDx-WP-Stamped-Drawings.user.js](SDx-WP-Stamped-Drawings.user.js).

## Install

1. Install and enable the Tampermonkey browser extension.
2. Open the [userscript installation link](https://raw.githubusercontent.com/atroedel-BMcD/SDx-IWP-Helper/main/SDx-WP-Stamped-Drawings.user.js) in that browser and choose **Install** in Tampermonkey. If the browser displays the source instead, create a new script in Tampermonkey, replace its contents with the file from this repository, and save it.
3. Sign in to SDx and reload the page. On **Results: General Work Packages**, look for the blue **IWP TOOLS** button in the grid toolbar, near **Export All to Excel**.

The script runs on matching `intergraphsmartcloud.com` pages. It requires access to the SDx session and loads `pdf-lib` and `JSZip` from cdnjs. The QR encoder is bundled with the userscript, so drawing-list QR generation does not require a third CDN library. If your browser or company network blocks `pdf-lib` or `JSZip`, stamping and ZIP creation will not work.

## Features

| Feature | What it does |
| --- | --- |
| Bulk IWP creation | Accepts a CSV with `Package Number` and `Package Title` by drag and drop or file picker, checks every package number against the current SDx configuration, then creates one General Work Package per row using Package Number as Name and Package Title as Description. Creation is sequential and each saved package is verified before continuing. |
| Superseded row highlighting | Checks SDx's **Superseded Documents** widget for work packages visible in the results grid. Packages with a count above zero are yellow when **Planned** and red when **Active** or **Executed**, by default. |
| Stamp and download | Creates a separate ZIP for each selected work package. Each attached PDF is stamped in red at the upper right of every page with `WP # <work package name> CONTROLLED` and the local stamping date beneath it as `STAMPED MM/DD/YY`. Every ZIP also includes a blue-banded, landscape 11×17 controlled drawing list with Alt Doc Name, Drawing Title, Rev, and a QR code linking to that IWP's SDx detail page with the right panel; long lists continue on additional pages. |
| Bulk IWP Drawing Association | Accepts a two-column CSV (`IWP Name`, `Alt Doc Name`) by drag and drop or file picker, checks that each exact IWP name exists in SDx and is visible in the current results grid, then uses each IWP's Update form to select current drawing revisions and add them together. Missing drawings and already-associated current drawings are skipped and reported. Each IWP change needs confirmation before SDx saves it. |
| Superseded download guard | Rechecks the selected package's superseded count before stamping. By default, any superseded document blocks that package's ZIP and displays a warning. |
| Per-download override | The download dialog shows this unchecked option only when SDx identifies superseded documents in a selected package. It names the affected packages. An override includes their superseded versions for that run, with a large, diagonal, translucent red **SUPERSEDED** mark on those PDF pages. The option must be selected again for every download. |
| Update superseded documents | For one package at a time, opens SDx's Update form, removes its superseded Required Documents associations, finds and adds the matching current revisions, and asks for confirmation before saving. |
| Color controls | Turn each status highlight on or off, choose its color, or reset the default colors from the **IWP TOOLS** menu. These preferences are stored in this browser. |

Only documents with an attached PDF file are included in stamped ZIPs. Other file types are skipped. Stamping changes the downloaded copies; it does not replace files in SDx.

## Create IWPs from a CSV

1. Open **Results: General Work Packages** in SDx and choose **IWP TOOLS** → **Bulk Create IWPs from CSV**.
2. Select **Download CSV template** for a blank file with the required headers, then drop one `.csv` file onto the upload area or use its file picker. The CSV must contain `Package Number` and `Package Title` columns. Other columns are ignored. Each nonblank data row creates one General Work Package; Package Number becomes **Name** and Package Title becomes **Description**.
3. Review the preview and select **Check names**. If any package number already exists in the current SDx configuration, the helper creates nothing; remove or rename the duplicate rows and upload again.
4. Select **Create IWPs**, review the final confirmation, and confirm. The helper creates packages in row order, verifies each saved Name and Description, and stops at the first error. Previously verified packages remain saved. Check SDx before retrying a name if creation stopped with an error.
5. Refresh the results page to see the new packages.

This workflow creates General Work Packages only. It does not populate the other CSV columns, add drawings, or set discipline, contract, or owning group.

## Download stamped drawings

1. Open **Results: General Work Packages** in SDx.
2. Check the box beside each work package you want. You can select more than one.
3. Click **IWP TOOLS** → **Stamp & download selected WPs**.
4. Wait while the helper checks the selected packages' **Superseded Documents** counts. If none have superseded documents, the dialog shows no warning or override; click **Download stamped drawings**.
5. If SDx finds superseded documents, the dialog names the affected packages and shows an unchecked override. Leave it unchecked to download only eligible packages, or check it and click **Include superseded and download** if you intentionally need superseded versions. The choice is never saved.

The helper downloads one ZIP per work package, named `<work package name>_Stamped_Drawings.zip`. An override ZIP adds `_Including_Superseded` to the name. If one package fails, the helper reports that package's error and continues with the other selected packages. A package with superseded documents produces **no ZIP** unless the override was selected. If SDx cannot verify the superseded count, the package is blocked.

Each controlled drawing list has a QR code for its work package's SDx detail page. Scan it while signed in to SDx to open the right panel and see the **live** Superseded Documents count. The count is not printed on the list and can change after the ZIP is downloaded. The QR code contains the SDx page address and work package ID, not a session token.

For an override download, the helper requires a downloadable PDF for every superseded document SDx reports. If any is missing, it stops that package without creating a ZIP. A package with no attached PDF drawings also produces no ZIP.

## Update superseded documents

1. In **Results: General Work Packages**, check **exactly one** work package, or open that package's side panel with no other package checked.
2. Click **IWP TOOLS** → **Update superseded documents**.
3. If the side panel is collapsed, the helper selects the package in the results grid and expands the panel. It confirms the panel shows the intended package before opening its **Update…** action.
4. The helper compares the Update form's superseded Required Documents with the **Superseded Documents** count, unlinks those associations in the draft, and searches SDx for one current revision of each document.
5. Review the confirmation listing the documents. Choose **OK** to save the work package update in SDx, or **Cancel** to discard the draft.
6. After saving, the helper checks that SDx reports zero superseded documents. Review any error or warning it displays.

The unlink control used here is the chain-break icon **inside the Update form's Required Documents grid**. The separate **Terminate** action in the work package Actions menu is not part of this workflow.

The helper stops before saving if the superseded counts disagree, a current revision cannot be uniquely identified, or the draft changes unexpectedly. If SDx reports superseded documents after a save, inspect the package in SDx; the helper will report that result.

## Build drawing associations from a CSV

1. Open **Results: General Work Packages** and make sure the IWPs you plan to use are visible in the current results grid.
2. Click **IWP TOOLS** → **Bulk IWP Drawing Association** and download the template.
3. Fill in one row per drawing. Repeat the IWP name for each drawing in that package. The required headers are `IWP Name` and `Alt Doc Name`.
4. Drop one `.csv` file onto the upload area or use its file picker, review the preview, and choose **Check IWP names**. The helper requires an exact IWP name match in SDx and in the visible grid. If any IWP is missing or not visible, no associations are changed; correct the name or adjust the results grid and retry.
5. Choose **Associate drawings**. For each IWP, the helper searches SDx for one current Document Revision whose Alt Doc Name matches exactly, including when the IWP currently has no Required Documents. It keeps matching drawings selected across searches, then uses one **ADD** action for the group. A current drawing already associated with the IWP is skipped. A missing, ambiguous, or unselectable drawing is skipped and named in the status panel; the remaining drawings continue.
6. Review the confirmation for each IWP, including the names skipped, and choose **OK** to save the matched associations in SDx. If no new drawings match, the helper discards the draft without saving. After a save, it reopens the IWP to verify that SDx saved the drawings. Cancel stops the remaining IWPs; earlier IWPs you confirmed stay saved.

The CSV upload only adds Required Documents associations. It does not create IWPs, replace superseded revisions, or change drawing records. Keep the IWP names and Alt Doc Names exactly as they appear in SDx.

## Change the row colors

Open **IWP TOOLS** and use the **Highlight WPs with superseded documents** controls. There is a separate on/off checkbox and color picker for **Planned**, **Active**, and **Executed**. **Reset colors** restores the default color values. Settings are saved locally in the current browser.

The grid scans visible work packages in the background and caches counts for up to five minutes. An unknown or unavailable count will not color a row; download still performs a fresh count check before stamping.

## Updates and versioning

Tampermonkey uses the script's `@updateURL`, `@downloadURL`, and `@version` metadata to check this repository for new versions. Its check schedule is controlled by Tampermonkey, so a new commit may not appear immediately. To update sooner, use Tampermonkey's **Check for userscript updates** command, then reload SDx. Confirm the installed version in Tampermonkey or the **IWP TOOLS** menu.

When publishing a code change, increment both the header `@version` and the `VERSION` constant in the script, then commit the updated file to `main`. Use patch versions for fixes (for example, `0.6.6` → `0.6.7`) and minor versions for new functionality. A README-only change does not require a userscript version change.

## Troubleshooting

| Message or symptom | What to check |
| --- | --- |
| **IWP TOOLS** is missing | Verify the userscript is enabled, reload SDx, and open the Work Packages results page. Confirm you are signed in. |
| Bulk IWP creation stops | Review the status panel. Any packages verified before the error remain saved. Check SDx for the package named in the error before retrying. |
| **No selected work packages** | Check one or more boxes in the results grid before downloading. For an update, check exactly one package or open its side panel with no boxes checked. |
| CSV reports an IWP name is missing | Check the spelling and capitalization against SDx, and make sure the IWP is present in the current General Work Packages results grid. |
| CSV drawing cannot be found | Check the Alt Doc Name in SDx. The helper requires one current Document Revision with an exact name match. |
| **Could not read the SDx session token** | Reload SDx, sign in if needed, and try again. |
| Superseded warning, no ZIP | This is the default safeguard. Update the package's associations, or explicitly select the override in the download dialog for that run. |
| **No attached PDF drawings** | Check that the package's documents have downloadable PDF attachments in SDx. Non-PDF files are not stamped. |
| Update stops before saving | Compare the package's **Superseded Documents** widget with its Update form. The helper requires matching counts and one current revision per superseded document. |
| Tampermonkey does not show a new release | Run **Check for userscript updates** and confirm that the repository's script header has a higher `@version` than your installed copy. |

The helper's status panel shows progress and package-specific errors. Closing that panel only hides the status; it does not cancel an operation already in progress.
