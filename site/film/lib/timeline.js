// The film's clock for the website: copied from the launch film (marketing repo, projects/olympus/launch-video,
// timeline.json; s02-choice from timeline-short.json) at a2772ab. Each scene plays on its own, from 0, on the paper desk.
window.OLY_TL = {
 "barSec": 2,
 "beatSec": 0.5,
 "fps": 30,
 "durationSec": 66.5,
 "standalone": true,
 "redaction": {
  "style": "typewriter",
  "step": 0.05,
  "maxDur": 0.6,
  "_note": "How text is redacted everywhere (paper.js OLY.redact): typewriter, Jamie's pick 2026-10-11 from the three-style test (one inked square per character, step s apart, the whole word in at most maxDur s). felt and clean remain as switches. Cues with 'redact': n get n keystrokes in the temp track."
 },
 "grain": {},
 "cues": {},
 "scenes": {
  "s01-open": {
   "start": 0,
   "dur": 5,
   "tail": 0.45,
   "opts": {},
   "beats": {
    "land": 0.5,
    "olympus": 1,
    "desc": 1.5,
    "plate": 2.5,
    "stamp": 3.25,
    "turn": 5
   }
  },
  "s02-hero": {
   "start": 0,
   "dur": 8,
   "tail": 0.55,
   "opts": {},
   "beats": {
    "line": 0.5,
    "strike1": 1.875,
    "strike2": 2.125,
    "reflow": 3,
    "request": 3.75,
    "buttons": 4.5,
    "block": 6,
    "cursorOut": 6.25,
    "reqstrike": 6.375,
    "pan": 8
   }
  },
  "s03-sources": {
   "start": 0,
   "dur": 4.5,
   "tail": 0,
   "opts": {},
   "beats": {
    "rows": 0.5,
    "rowsLast": 1.75,
    "more": 2.25,
    "own": 2.5,
    "out": 4
   }
  },
  "s04-classify": {
   "start": 0,
   "dur": 4.75,
   "tail": 0.5,
   "opts": {},
   "beats": {
    "r1": 0.375,
    "r3": 1.375,
    "fast": 1.875,
    "fastLast": 2.875,
    "secretRow": 3.125,
    "secret": 3.375,
    "resume": 3.875
   }
  },
  "s05-local": {
   "start": 0,
   "dur": 7,
   "tail": 0.55,
   "opts": {},
   "beats": {
    "head": 0.75,
    "rows": 1.25,
    "rowsLast": 1.875,
    "foot": 2.25,
    "panel": 3.5,
    "answer": 3.75,
    "out": 7
   }
  },
  "s06-venice": {
   "start": 0,
   "dur": 6,
   "tail": 2,
   "opts": {},
   "beats": {
    "head": 0.75,
    "q": 1.5,
    "strike": 4.25,
    "fold": 6,
    "sealed": 6.75,
    "out": 7.5,
    "sub": 1.125
   }
  },
  "s07-zk": {
   "start": 0,
   "dur": 4.5,
   "tail": 0,
   "opts": {},
   "beats": {
    "head": 2.25,
    "sub": 2.5,
    "whos": 3.25,
    "push": 4,
    "hd": 2
   }
  },
  "s08-zkq": {
   "start": 0,
   "dur": 16.75,
   "tail": 0.45,
   "opts": {},
   "beats": {
    "q": 1,
    "hl1": 4,
    "hl2": 4.25,
    "hl3": 4.5,
    "id1": 5,
    "id2": 5.5,
    "id3": 5.875,
    "rewrite": 6.75,
    "route": 9.75,
    "packet": 11.5,
    "hop1": 12.25,
    "hop2": 13,
    "hop3": 13.75,
    "arrive": 14.5,
    "paid": 15.25,
    "turn": 16.75
   }
  },
  "s09-terms": {
   "start": 0,
   "dur": 4,
   "tail": 0.6,
   "opts": {},
   "beats": {
    "l1": 0.5,
    "t1": 1,
    "l2": 1.5,
    "t2": 2,
    "l3": 2.5,
    "t3": 3
   }
  },
  "s10-close": {
   "start": 0,
   "dur": 6,
   "tail": 0,
   "opts": {},
   "beats": {
    "land": 0,
    "line": 0.625,
    "plate": 1,
    "button": 1.75,
    "url": 2.5
   }
  },
  "s02-choice": {
   "start": 0,
   "dur": 5.5,
   "tail": 0.45,
   "opts": {},
   "beats": {
    "land": 0.5,
    "line": 1,
    "or": 1.375,
    "best": 1.75,
    "pick": 2.25,
    "strike": 3.25,
    "and": 4,
    "turn": 5.5
   }
  }
 }
};
