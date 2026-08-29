/* Progress plumbing for the load-time analysis passes. No DOM use — also
 * loadable in node for tests.
 *
 * Everything the viewer does to a log on load — parsing it, rebuilding the
 * map, reconstructing shell flight — is a plain synchronous loop over a few
 * hundred thousand records, and a browser paints nothing at all while one
 * is running. So each heavy pass is written twice over: as a generator that
 * yields { fraction, label } every few thousand records, and as the
 * ordinary synchronous function of the same name, which is that generator
 * drained in one go. Node callers (tests, tools) keep the plain function;
 * the viewer drives the generator and hands the event loop a turn between
 * chunks, which is the only way the loading bar gets drawn.
 *
 * A yielded `fraction` is progress through the yielding pass itself, 0 to
 * 1; sub_progress() maps that onto the caller's own scale, so each pass
 * stays ignorant of where it sits in the whole job. `label` is optional
 * and names the pass for the bar. */
"use strict";
(function () {

/* Records between progress yields. Small enough that a chunk is tens of
 * milliseconds even in the slowest pass (shell matching, ~20 µs a record),
 * large enough that the yields themselves cost nothing. */
const PROGRESS_CHUNK = 1024;

/* Run a steps-generator to completion, ignoring its progress, and return
 * whatever it returns. */
function drain(steps) {
	let step = steps.next();
	while (!step.done) step = steps.next();
	return step.value;
}

/* Delegate to a sub-generator, rescaling its 0-to-1 fraction into the
 * [lo, hi] slice of the caller's own progress. `label` names the
 * sub-generator's work, except where it labels its own phases. */
function* sub_progress(steps, lo, hi, label) {
	let step = steps.next();
	while (!step.done) {
		yield {
			fraction: lo + (hi - lo) * step.value.fraction,
			label: step.value.label || label,
		};
		step = steps.next();
	}
	return step.value;
}

const BoloProgress = { PROGRESS_CHUNK, drain, sub_progress };

if (typeof module !== "undefined" && module.exports) {
	module.exports = BoloProgress;
} else {
	window.BoloProgress = BoloProgress;
}

})();
