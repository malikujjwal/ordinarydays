/**
 * CloudFront Function, viewer-request, for the web distribution.
 *
 * A **CloudFront Function**, not Lambda@Edge: this is a string rewrite, it runs in
 * sub-millisecond time at the edge, and it is free up to 2M invocations/month. Lambda@Edge
 * would add replication delay to every deploy for no gain (`aws-services.md` §1.6).
 *
 * Two jobs, both there because Expo Router's static export is a tree of `index.html` files
 * and S3 has no notion of a directory index below the root:
 *
 * 1. `/plans` has no object behind it — the export wrote `/plans/index.html`. Without this
 *    rewrite every route but `/` is a 404.
 * 2. `/invite/<token>` is a *dynamic* segment. No object exists for any particular token;
 *    the export wrote one pre-rendered shell for the route, which fetches
 *    `/public/v1/invites/:token` client-side once it loads.
 *
 * This file is plain JavaScript on purpose. The CloudFront Functions runtime is not Node —
 * there are no modules, no `require`, and no access to the network or the filesystem.
 */

// The pre-rendered shell Expo Router emits for `app/invite/[token].tsx`.
//
// VERIFY THIS AGAINST A REAL EXPORT before the web build first deploys: the filename comes
// from Expo Router's static-export convention, not from anything in this repository, and a
// wrong value here is a 404 on every invite link — the one surface reached by people who do
// not have the app. P0-22 produces the first real `expo export`; P5 ships it.
var INVITE_SHELL = '/invite/[token].html';
var INVITE_PATH = /^\/invite\/[^/]+\/?$/;

// biome-ignore lint/correctness/noUnusedVariables: CloudFront invokes `handler` by name.
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (INVITE_PATH.test(uri)) {
    request.uri = INVITE_SHELL;
    return request;
  }

  // `/plans/` -> `/plans/index.html`
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
    return request;
  }

  // `/plans` -> `/plans/index.html`, but leave `/logo.png` and `/_expo/static/x.js` alone.
  // Testing the last segment rather than the whole path is what stops a dotted directory
  // name from defeating it.
  var lastSegment = uri.slice(uri.lastIndexOf('/') + 1);
  if (lastSegment.indexOf('.') === -1) {
    request.uri = uri + '/index.html';
  }

  return request;
}
