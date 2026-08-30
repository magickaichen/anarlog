import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowLeft, Check, DotsThreeVertical } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { Button } from "@anlg/ui/components/ui/button";
import {
  AppFloatingPanel,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@anlg/ui/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@anlg/ui/components/ui/tooltip";

import { getMeetingLanguageOptions } from "./meeting-language-options";
import { ActionableTooltipContent } from "./shared";

import { useSession, updateSession } from "~/session/queries";
import {
  CORE_TRANSCRIPTION_LANGUAGE_CODES,
  getBaseLanguageDisplayName,
} from "~/settings/general/language";
import { useConfigValue } from "~/shared/config";
import { getTranscriptionLanguages } from "~/stt/capabilities";
import { normalizeTranscriptionLanguages } from "~/stt/transcription-policy";
import { useSTTConnection } from "~/stt/useSTTConnection";
import { useUploadFile } from "~/stt/useUploadFile";

export function OptionsMenu({
  sessionId,
  disabled,
  warningMessage,
  hideUploadActions = false,
  onConfigure,
  children,
}: {
  sessionId: string;
  disabled: boolean;
  warningMessage: string;
  hideUploadActions?: boolean;
  onConfigure?: () => void;
  children: React.ReactNode;
}) {
  const { i18n, t } = useLingui();
  const [open, setOpen] = useState(false);
  const [multilingualOpen, setMultilingualOpen] = useState(false);
  const [draftLanguages, setDraftLanguages] = useState<string[]>(["en"]);
  const { uploadAudio, uploadTranscript } = useUploadFile(sessionId);
  const session = useSession(sessionId);
  const aiLanguage = useConfigValue("ai_language");
  const spokenLanguages = useConfigValue("spoken_languages");
  const languageOptions = useMemo(
    () =>
      getMeetingLanguageOptions(
        getTranscriptionLanguages(aiLanguage, spokenLanguages),
        CORE_TRANSCRIPTION_LANGUAGE_CODES,
      ),
    [aiLanguage, spokenLanguages],
  );
  const { conn } = useSTTConnection(session?.transcription ?? undefined);
  const provider = session?.transcription?.provider ?? conn?.provider;
  const model = session?.transcription?.model ?? conn?.model;
  const currentLanguages = normalizeTranscriptionLanguages(
    session?.transcription?.languages ??
      getTranscriptionLanguages(aiLanguage, spokenLanguages),
  );
  const updateTranscription = useMutation({
    mutationFn: async (languages: string[]) => {
      if (!provider || !model) return;
      await updateSession(sessionId, {
        transcription: { provider, model, languages },
      });
    },
    onSuccess: () => setOpen(false),
  });

  const handleUploadAudio = useCallback(() => {
    if (disabled) {
      return;
    }
    setOpen(false);
    uploadAudio();
  }, [disabled, uploadAudio]);

  const handleUploadTranscript = useCallback(() => {
    if (disabled) {
      return;
    }
    setOpen(false);
    uploadTranscript();
  }, [disabled, uploadTranscript]);

  const openMultilingual = useCallback(() => {
    setDraftLanguages(currentLanguages);
    setMultilingualOpen(true);
  }, [currentLanguages]);

  const toggleDraftLanguage = useCallback((language: string) => {
    setDraftLanguages((current) =>
      current.includes(language)
        ? current.filter((item) => item !== language)
        : [...current, language],
    );
  }, []);

  const moreButton = (
    <button
      className="text-primary-foreground/70 hover:text-primary-foreground dark:text-primary/65 dark:hover:text-primary absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer transition-colors disabled:opacity-50"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        setOpen(true);
      }}
    >
      <DotsThreeVertical className="size-4" />
      <span className="sr-only">
        <Trans>More options</Trans>
      </span>
    </button>
  );

  if (disabled && warningMessage) {
    return (
      <div className="relative flex items-center">
        {children}
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <span className="inline-block">{moreButton}</span>
          </TooltipTrigger>
          <TooltipContent side="top" align="end">
            <ActionableTooltipContent
              message={warningMessage}
              action={
                onConfigure
                  ? {
                      label: t`Configure`,
                      handleClick: onConfigure,
                    }
                  : undefined
              }
            />
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  if (disabled) {
    return (
      <div className="relative flex items-center">
        {children}
        {moreButton}
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="relative flex items-center">
          {children}
          {moreButton}
        </div>
      </PopoverTrigger>
      <PopoverContent
        variant="app"
        side="top"
        align="center"
        sideOffset={8}
        className="w-56"
      >
        <AppFloatingPanel className="flex flex-col gap-1 p-1">
          {multilingualOpen ? (
            <>
              <Button
                variant="ghost"
                className="h-9 justify-start px-3"
                onClick={() => setMultilingualOpen(false)}
              >
                <ArrowLeft className="mr-2 size-4" />
                <Trans>Meeting languages</Trans>
              </Button>
              <div className="max-h-56 overflow-y-auto">
                {languageOptions.map((option) => {
                  const language = option.languages[0] ?? "en";
                  const selected = draftLanguages.includes(language);
                  return (
                    <Button
                      key={language}
                      variant="ghost"
                      className="h-9 w-full justify-start px-3"
                      onClick={() => toggleDraftLanguage(language)}
                    >
                      <Check
                        className={
                          selected ? "mr-2 size-4" : "mr-2 size-4 opacity-0"
                        }
                      />
                      <span className="truncate text-sm">
                        {getBaseLanguageDisplayName(language, i18n.locale)}
                      </span>
                    </Button>
                  );
                })}
              </div>
              <Button
                className="mx-2 my-1 h-9"
                disabled={
                  draftLanguages.length < 2 || updateTranscription.isPending
                }
                onClick={() => updateTranscription.mutate(draftLanguages)}
              >
                <Trans>Apply multilingual</Trans>
              </Button>
            </>
          ) : (
            <>
              <span className="text-muted-foreground px-3 pt-1 text-xs">
                <Trans>Meeting language</Trans>
              </span>
              <div className="max-h-56 overflow-y-auto">
                {languageOptions.map((option) => {
                  const label = getBaseLanguageDisplayName(
                    option.languages[0] ?? "en",
                    i18n.locale,
                  );
                  return (
                    <Button
                      key={option.languages.join(",")}
                      variant="ghost"
                      className="h-9 w-full justify-start px-3"
                      disabled={
                        !provider || !model || updateTranscription.isPending
                      }
                      onClick={() =>
                        updateTranscription.mutate(option.languages)
                      }
                    >
                      <span className="truncate text-sm">{label}</span>
                    </Button>
                  );
                })}
              </div>
              <Button
                variant="ghost"
                className="h-9 justify-start px-3"
                disabled={!provider || !model || updateTranscription.isPending}
                onClick={openMultilingual}
              >
                <span className="truncate text-sm">
                  <Trans>Multilingual…</Trans>
                </span>
              </Button>
              {!hideUploadActions && (
                <>
                  <div className="bg-border mx-2 my-1 h-px" />
                  <Button
                    variant="ghost"
                    className="h-9 justify-center px-3 whitespace-nowrap"
                    onClick={handleUploadAudio}
                  >
                    <span className="text-sm">
                      <Trans>Upload audio</Trans>
                    </span>
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-9 justify-center px-3 whitespace-nowrap"
                    onClick={handleUploadTranscript}
                  >
                    <span className="text-sm">
                      <Trans>Upload transcript</Trans>
                    </span>
                  </Button>
                </>
              )}
            </>
          )}
        </AppFloatingPanel>
      </PopoverContent>
    </Popover>
  );
}
