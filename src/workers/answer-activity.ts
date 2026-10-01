/**
 * Answers in flight on this worker (source answers, ChatGPT evidence
 * searches, private answer panel jobs). Answers come first: when the count
 * goes from 0 to 1 the worker preempts background model work (the tier
 * sniffer aborts its in-flight call), and while it is above 0 that work
 * yields (the sniffer's `shouldYield`). It resumes on its next tick.
 */
export interface AnswerActivity {
  readonly busy: boolean;
  readonly inFlight: number;
  begin(): void;
  end(): void;
  /** Runs `work` as one answer in flight. */
  run<T>(work: () => Promise<T>): Promise<T>;
}

export function createAnswerActivity(onBusy: () => void): AnswerActivity {
  let inFlight = 0;
  const activity: AnswerActivity = {
    get busy() {
      return inFlight > 0;
    },
    get inFlight() {
      return inFlight;
    },
    begin() {
      inFlight += 1;
      if (inFlight === 1) {
        try {
          onBusy();
        } catch {
          // Preempting background work never fails an answer.
        }
      }
    },
    end() {
      inFlight = Math.max(0, inFlight - 1);
    },
    async run(work) {
      activity.begin();
      try {
        return await work();
      } finally {
        activity.end();
      }
    },
  };
  return activity;
}
