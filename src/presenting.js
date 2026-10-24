// presenting.js: one presenter at a time (rooms-lab-plan.md, section 7), worked out the same way on every
// page from the same messages, so the pages agree without asking anyone.
//
// The presenter says so to everyone ({ kind: "presenting", on }). If two people start at the same moment,
// both pages hear the other, and the one with the smaller peer id keeps the stage (every page compares the
// same two ids, so they all agree); the other page stops its share.

/** The presenter after `from` says it's presenting (on: true) or has stopped (on: false). */
export function afterAnnounce(current, from, on) {
  if (!on) return current === from ? null : current;
  if (!current || current === from) return from;
  return current < from ? current : from;
}

/** The presenter once the people in the room are `here` (ids of people connected now; an away host
 *  isn't here, and their share stopped with the drop). */
export const afterPeople = (current, here) => (current && !here.includes(current) ? null : current);
