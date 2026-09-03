import { Trans } from "@lingui/react/macro";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import {
  confirmTranscriptRefinement,
  getTranscriptRefinementReview,
  retryTranscriptRefinement,
  type TranscriptRefinement,
} from "~/stt/refinement";
import type { RefinementStatus } from "~/stt/refinement-queries";

export function RefinementNotice({
  status,
  error,
  onRetry,
  onReview,
  pending,
}: {
  status: TranscriptRefinement["status"];
  error: string | null;
  onRetry: () => void;
  onReview: () => void;
  pending: boolean;
}) {
  return (
    <div
      role="status"
      className="border-border bg-muted/40 flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm"
    >
      <span>
        {status === "failed" ? (
          <Trans>Refinement failed. Your live transcript is kept.</Trans>
        ) : status === "awaiting_confirmation" ? (
          <Trans>
            Refined transcript ready. Review changes before replacing your
            edits.
          </Trans>
        ) : status === "succeeded" ? (
          <Trans>Transcript refined</Trans>
        ) : status === "running" ? (
          <Trans>Refining transcript. Live text remains available.</Trans>
        ) : (
          <Trans>Refinement queued. Live text remains available.</Trans>
        )}
      </span>
      {status === "failed" && (
        <button
          type="button"
          disabled={pending}
          onClick={onRetry}
          className="text-primary underline"
        >
          <Trans>Retry refinement</Trans>
        </button>
      )}
      {status === "awaiting_confirmation" && (
        <button
          type="button"
          onClick={onReview}
          className="text-primary underline"
        >
          <Trans>Review changes</Trans>
        </button>
      )}
      {error && status === "failed" && (
        <span className="text-muted-foreground w-full">{error}</span>
      )}
    </div>
  );
}

export function TranscriptRefinementStatus({ job }: { job: RefinementStatus }) {
  const [reviewing, setReviewing] = useState(false);
  const review = useQuery({
    queryKey: ["refinement-review", job.id],
    queryFn: () => getTranscriptRefinementReview(job.id),
    enabled: reviewing && job.status === "awaiting_confirmation",
  });
  const retry = useMutation({
    mutationFn: () => retryTranscriptRefinement(job.id),
  });
  const confirm = useMutation({
    mutationFn: () => {
      if (!review.data)
        throw new Error("Review the transcript before confirming.");
      return confirmTranscriptRefinement(job.id, review.data.revision);
    },
    onError: () => {
      void review.refetch();
    },
  });
  return (
    <>
      <RefinementNotice
        status={job.status}
        error={job.error}
        onRetry={() => retry.mutate()}
        onReview={() => setReviewing((value) => !value)}
        pending={retry.isPending}
      />
      {reviewing && job.status === "awaiting_confirmation" && (
        <section className="border-border max-h-80 overflow-auto border-b p-4 text-sm">
          {review.isPending && (
            <p>
              <Trans>Loading changes…</Trans>
            </p>
          )}
          {review.data && (
            <RefinementDifference
              before={review.data.before}
              after={review.data.after}
              onConfirm={() => confirm.mutate()}
              pending={confirm.isPending || review.isFetching}
            />
          )}
          {(review.error || confirm.error) && (
            <p role="alert">{(review.error || confirm.error)?.message}</p>
          )}
        </section>
      )}
      {retry.error && (
        <p role="alert" className="p-4 text-sm">
          {retry.error.message}
        </p>
      )}
    </>
  );
}

export function RefinementDifference({
  before,
  after,
  onConfirm,
  pending,
}: {
  before: string;
  after: string;
  onConfirm: () => void;
  pending: boolean;
}) {
  const left = before.split(/\s+/);
  const right = after.split(/\s+/);
  let start = 0;
  while (
    start < left.length &&
    start < right.length &&
    left[start] === right[start]
  )
    start++;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (
    leftEnd > start &&
    rightEnd > start &&
    left[leftEnd - 1] === right[rightEnd - 1]
  ) {
    leftEnd--;
    rightEnd--;
  }
  const prefix = left.slice(Math.max(0, start - 8), start).join(" ");
  const suffix = left.slice(leftEnd, leftEnd + 8).join(" ");
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="mb-2 font-medium">
            <Trans>Your current transcript</Trans>
          </h3>
          <p>
            {prefix}{" "}
            <del className="bg-red-500/10">
              {left.slice(start, leftEnd).join(" ")}
            </del>{" "}
            {suffix}
          </p>
        </div>
        <div>
          <h3 className="mb-2 font-medium">
            <Trans>Refined transcript</Trans>
          </h3>
          <p>
            {prefix}{" "}
            <ins className="bg-green-500/10">
              {right.slice(start, rightEnd).join(" ")}
            </ins>{" "}
            {suffix}
          </p>
        </div>
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={onConfirm}
        className="text-primary mt-3 underline"
      >
        <Trans>Replace with refined transcript</Trans>
      </button>
    </>
  );
}
