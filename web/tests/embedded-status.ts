import type { Page } from '@playwright/test';

// Every page's head (www/common/menuHead.inc) carries the player's status,
// fetched from api/system/status as PHP builds the page:
//   <script ...>lastStatusJSON = {...}; lastStatus = lastStatusJSON.status;</script>
// The page draws from it before its own socket or poll answers, so a test
// that changes what the page is told about the status has to change this
// copy too, or the page shows the player's real status first.
//
// editEmbeddedStatus(page, edit) runs edit on that copy in every page
// document loaded after it; edit changes the object in place.
const EMBEDDED = /(lastStatusJSON = )(\{.*?\})(; lastStatus = lastStatusJSON\.status;)/s;

export async function editEmbeddedStatus(page: Page, edit: (status: any) => void) {
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.fallback();
    const response = await route.fetch();
    const body = await response.text();
    const m = EMBEDDED.exec(body);
    if (!m) return route.fulfill({ response, body });
    const status = JSON.parse(m[2]);
    edit(status);
    return route.fulfill({ response, body: body.replace(EMBEDDED, (_all, a, _j, b) => a + JSON.stringify(status) + b) });
  });
}
