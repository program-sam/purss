import { test } from "node:test";
import assert from "node:assert/strict";
import { ANNOTATION_BODY_MAX, ANNOTATION_CONTEXT_MAX, ANNOTATION_QUOTE_MAX, annotationIdSchema } from "@purss/domain";
import { BODY_MAX, CONTEXT_MAX, QUOTE_MAX } from "./limits.ts";
import { CONTEXT_CHARS } from "./anchor.ts";
import { newAnnotationId } from "./ids.ts";

test("the web app's annotation limits are the server's", () => {
  assert.deepEqual([BODY_MAX, QUOTE_MAX, CONTEXT_MAX], [ANNOTATION_BODY_MAX, ANNOTATION_QUOTE_MAX, ANNOTATION_CONTEXT_MAX]);
  assert.ok(CONTEXT_CHARS <= CONTEXT_MAX, "the context a highlight stores fits what the server accepts");
});

test("ids made on the device are ones the server accepts, sortable by time and distinct", () => {
  const a = newAnnotationId(Date.UTC(2026, 10, 1));
  const b = newAnnotationId(Date.UTC(2026, 10, 2));
  assert.ok(annotationIdSchema.safeParse(a).success, a);
  assert.ok(a.slice(4, 14) < b.slice(4, 14));
  assert.notEqual(newAnnotationId(), newAnnotationId());
});
