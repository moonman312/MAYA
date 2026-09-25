import { ReviewFindings } from "@/components/onboarding/review-findings";
import { ArrivalFlash } from "@/components/deep-links/arrival-bits";
import { links } from "@/lib/deep-links";
import { queryOf } from "@/lib/deep-links/member-role";

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // A link can open the recommendations step and point at a kind of card.
  // Nothing is confirmed, and the go-live dialog is never opened.
  const arrival = links.readArrival(queryOf(await searchParams));
  const initialStep = arrival.dest === "review" && arrival.params.step === "recommendations" ? "recommendations" : "assumptions";
  return (
    <>
      <ArrivalFlash
        flashIds={{
          "guardrail-suggestion": "review.guardrail_suggestion",
          "rule-suggestion": "review.rule_suggestion",
          "starter-rules": "review.starter-rules",
        }}
      />
      <ReviewFindings initialStep={initialStep} />
    </>
  );
}
