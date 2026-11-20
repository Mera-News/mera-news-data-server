/**
 * A followed story is a topic match plus zero or more gates, and an article
 * joins it only when it passes the topic match and every gate.
 *
 * A gate is a kind, a text derived from the topic text ("Netherlands" for
 * "Femicide in the Netherlands") and that text's query vector. It passes when
 * the cosine between the gate vector and the article's retrieval vector is at
 * or above its kind's threshold.
 *
 * A kind exists here only with a threshold measured on a labelled set. A
 * generated gate of any other kind is dropped, never applied with a guessed
 * number. Adding a kind or changing a threshold bumps `STORY_GATES_VERSION`,
 * which regenerates stored gates and invalidates cached followed-story answers.
 */
export const STORY_GATE_KINDS = {
  /**
   * Where the story happens. Measured on 40 articles from one followed story
   * (10 set in the Netherlands, 30 elsewhere), gate text "Netherlands": every
   * Dutch one scored at least 0.274 and the highest other one 0.287 (a
   * Luxembourg story), the rest at most 0.246. At 0.27, precision 0.91 and
   * recall 1.00. The retrieval vector carries the publisher's country, so a
   * story set abroad from a publisher based in the place can pass.
   */
  place: { threshold: 0.27 },
} as const;

export type StoryGateKind = keyof typeof STORY_GATE_KINDS;

export const STORY_GATES_VERSION = 1;

export interface StoryGate {
  kind: StoryGateKind;
  text: string;
  vector: number[];
}

export const isStoryGateKind = (kind: string): kind is StoryGateKind =>
  Object.prototype.hasOwnProperty.call(STORY_GATE_KINDS, kind);

/** True when the article vector clears every gate. Vectors are L2-normalized. */
export function passesStoryGates(
  gates: StoryGate[],
  articleVector: number[] | null | undefined,
): boolean {
  if (gates.length === 0) return true;
  if (!articleVector || articleVector.length === 0) return false;
  return gates.every((g) => {
    if (g.vector.length !== articleVector.length) return false;
    let dot = 0;
    for (let i = 0; i < g.vector.length; i++) {
      dot += g.vector[i] * articleVector[i];
    }
    return dot >= STORY_GATE_KINDS[g.kind].threshold;
  });
}
