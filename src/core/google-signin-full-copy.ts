/**
 * The words for the state where Olympus's own Google sign-in has reached
 * Google's user limit (`google-publisher-capacity.ts`). Dependency-free on
 * purpose: the dashboard, the ChatGPT panel and the tool errors all import it,
 * and none of them should pull in the network or crypto code beside it.
 */

/**
 * The owner's words for the full state. The first three sentences are the
 * product copy; the dashboard shows them as the card's own line.
 */
export const GOOGLE_SIGNIN_FULL_SENTENCE =
  'Google sign-in is full for the moment. We\'re working on it. For now, you can still connect Google by using your own Google app.';

/** The same, for a surface that cannot start the own-app steps itself (ChatGPT). */
export const GOOGLE_SIGNIN_FULL_ON_COMPUTER_SENTENCE =
  `${GOOGLE_SIGNIN_FULL_SENTENCE} Open Olympus on your computer to set it up.`;

/** The error code the dashboard start route answers with while the sign-in is full. */
export const GOOGLE_SIGNIN_FULL_CODE = 'google_signin_full';
