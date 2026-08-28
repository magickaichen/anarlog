use anlg_ws_client::client::Message;
use owhisper_interface::ListenParams;
use owhisper_interface::stream::{
    Alternatives, Channel, Metadata, ProviderTurnCorrection, ProviderTurnCorrectionKind,
    StreamResponse,
};
use serde::{Deserialize, Deserializer};

use super::AssemblyAIAdapter;
use super::language::{U3_STREAMING_LANGUAGES, U35_STREAMING_LANGUAGES};
use crate::adapter::RealtimeSttAdapter;
use crate::adapter::parsing::{WordBuilder, calculate_time_span, ms_to_secs};

// https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api.md
impl RealtimeSttAdapter for AssemblyAIAdapter {
    fn provider_name(&self) -> &'static str {
        "assemblyai"
    }

    fn is_supported_languages(
        &self,
        languages: &[anlg_language::Language],
        _model: Option<&str>,
    ) -> bool {
        languages.is_empty() || Self::language_support_live(languages).is_supported()
    }

    fn supports_native_multichannel(&self) -> bool {
        // https://www.assemblyai.com/docs/universal-streaming/multichannel-streams.md
        false
    }

    fn build_ws_url(&self, api_base: &str, params: &ListenParams, _channels: u8) -> url::Url {
        let (mut url, existing_params) = Self::streaming_ws_url(api_base);
        let resolved_model = Self::resolve_live_model(params);

        {
            let mut query_pairs = url.query_pairs_mut();

            for (key, value) in &existing_params {
                query_pairs.append_pair(key, value);
            }

            let sample_rate = params.sample_rate.to_string();
            query_pairs.append_pair("sample_rate", &sample_rate);
            query_pairs.append_pair("encoding", "pcm_s16le");
            let (speech_model, language_detection) = resolved_model.query_config(params);

            query_pairs.append_pair("speech_model", speech_model);
            if language_detection {
                query_pairs.append_pair("language_detection", "true");
            }
            if matches!(resolved_model, ResolvedLiveModel::WhisperRt) {
                query_pairs.append_pair("format_turns", "true");
            }

            if let Some(custom) = &params.custom_query
                && let Some(max_silence) = custom.get("max_turn_silence")
            {
                query_pairs.append_pair("max_turn_silence", max_silence);
            }

            if matches!(
                resolved_model,
                ResolvedLiveModel::Universal35Pro | ResolvedLiveModel::U3RtPro
            ) {
                query_pairs.append_pair("speaker_labels", "true");

                if let Some(max_speakers) = Self::streaming_max_speakers(params) {
                    query_pairs.append_pair("max_speakers", &max_speakers.to_string());
                }
            }

            if !params.keywords.is_empty() {
                let keyterms_json = serde_json::to_string(&params.keywords).unwrap_or_default();
                query_pairs.append_pair("keyterms_prompt", &keyterms_json);
            }
        }

        url
    }

    fn build_auth_header(&self, api_key: Option<&str>) -> Option<(&'static str, String)> {
        api_key.and_then(|k| crate::providers::Provider::AssemblyAI.build_auth_header(k))
    }

    fn keep_alive_message(&self) -> Option<Message> {
        None
    }

    fn finalize_message(&self) -> Message {
        Message::Text(r#"{"type":"Terminate"}"#.into())
    }

    fn parse_response(&self, raw: &str) -> Vec<StreamResponse> {
        let msg: AssemblyAIMessage = match serde_json::from_str(raw) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(
                    error = ?e,
                    anarlog.payload.size_bytes = raw.len() as u64,
                    "assemblyai_json_parse_failed"
                );
                return vec![];
            }
        };

        match msg {
            AssemblyAIMessage::Begin { id, expires_at } => {
                tracing::debug!(
                    anarlog.stt.provider_session.id = %id,
                    anarlog.stt.provider_session.expires_at = %expires_at,
                    "assemblyai_session_began"
                );
                vec![]
            }
            AssemblyAIMessage::Turn(turn) => Self::parse_turn(turn),
            AssemblyAIMessage::SpeakerRevision { revisions } => revisions
                .into_iter()
                .flat_map(Self::parse_speaker_revision)
                .collect(),
            AssemblyAIMessage::Termination {
                audio_duration_seconds,
                session_duration_seconds,
            } => {
                tracing::debug!(
                    anarlog.audio.duration_s = audio_duration_seconds,
                    anarlog.stt.provider_session.duration_s = session_duration_seconds,
                    "assemblyai_session_terminated"
                );
                vec![StreamResponse::TerminalResponse {
                    request_id: String::new(),
                    created: String::new(),
                    duration: audio_duration_seconds as f64,
                    channels: 1,
                }]
            }
            AssemblyAIMessage::Error { error } => {
                tracing::error!(error = %error, "assemblyai_error");
                vec![StreamResponse::ErrorResponse {
                    error_code: None,
                    error_message: error,
                    provider: "assemblyai".to_string(),
                }]
            }
            AssemblyAIMessage::Unknown => {
                tracing::debug!(
                    anarlog.payload.size_bytes = raw.len() as u64,
                    "assemblyai_unknown_message"
                );
                vec![]
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum AssemblyAIMessage {
    Begin {
        id: String,
        expires_at: u64,
    },
    Turn(TurnMessage),
    SpeakerRevision {
        #[serde(default)]
        revisions: Vec<SpeakerRevisionItem>,
    },
    Termination {
        audio_duration_seconds: u64,
        session_duration_seconds: u64,
    },
    Error {
        error: String,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
struct TurnMessage {
    #[serde(default)]
    #[allow(dead_code)]
    turn_order: u32,
    #[serde(default)]
    turn_is_formatted: bool,
    #[serde(default)]
    end_of_turn: bool,
    #[serde(default)]
    transcript: String,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_speaker_label")]
    speaker_label: Option<String>,
    #[serde(default)]
    utterance: Option<String>,
    #[serde(default)]
    language_code: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    language_confidence: Option<f64>,
    #[serde(default)]
    end_of_turn_confidence: f64,
    #[serde(default)]
    words: Vec<AssemblyAIWord>,
}

#[derive(Debug, Deserialize)]
struct AssemblyAIWord {
    text: String,
    #[serde(default)]
    start: u64,
    #[serde(default)]
    end: u64,
    #[serde(default)]
    confidence: f64,
    #[serde(default)]
    #[allow(dead_code)]
    word_is_final: bool,
    #[serde(default, deserialize_with = "deserialize_word_speaker")]
    speaker: WordSpeaker,
}

#[derive(Debug, Default)]
enum WordSpeaker {
    #[default]
    Missing,
    Explicit(Option<String>),
}

fn deserialize_word_speaker<'de, D>(deserializer: D) -> Result<WordSpeaker, D::Error>
where
    D: Deserializer<'de>,
{
    serde_json::Value::deserialize(deserializer).map(|value| match value {
        serde_json::Value::String(label) => WordSpeaker::Explicit(Some(label)),
        _ => WordSpeaker::Explicit(None),
    })
}

fn deserialize_speaker_label<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    serde_json::Value::deserialize(deserializer).map(|value| match value {
        serde_json::Value::String(label) => Some(label),
        _ => None,
    })
}

#[derive(Debug, Deserialize)]
struct SpeakerRevisionItem {
    turn_order: u32,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_speaker_label")]
    speaker_label: Option<String>,
    #[serde(default)]
    words: Vec<AssemblyAIWord>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResolvedLiveModel {
    Universal35Pro,
    U3RtPro,
    WhisperRt,
}

impl AssemblyAIAdapter {
    fn resolve_live_model(params: &ListenParams) -> ResolvedLiveModel {
        let requested = match params.model.as_deref() {
            Some("whisper-rt") => return ResolvedLiveModel::WhisperRt,
            Some("u3-rt-pro" | "universal-3-pro") => ResolvedLiveModel::U3RtPro,
            _ => ResolvedLiveModel::Universal35Pro,
        };
        let supported_languages = requested.streaming_languages();

        if params.languages.is_empty()
            || params
                .languages
                .iter()
                .all(|language| supported_languages.contains(&language.iso639().code()))
        {
            requested
        } else {
            ResolvedLiveModel::WhisperRt
        }
    }

    fn streaming_max_speakers(params: &ListenParams) -> Option<u32> {
        params.max_speakers.or(params.num_speakers).or_else(|| {
            params
                .custom_query
                .as_ref()
                .and_then(|custom| custom.get("max_speakers"))
                .and_then(|value| value.parse().ok())
        })
    }

    fn parse_speaker_label(label: Option<&str>) -> Option<i32> {
        let label = label?.trim();
        if label.len() != 1 {
            return None;
        }

        let upper = label.as_bytes()[0].to_ascii_uppercase();
        if !upper.is_ascii_uppercase() {
            return None;
        }

        Some((upper - b'A') as i32)
    }

    fn parse_turn(turn: TurnMessage) -> Vec<StreamResponse> {
        Self::parse_turn_with_correction(turn, ProviderTurnCorrectionKind::Pending)
    }

    fn parse_speaker_revision(revision: SpeakerRevisionItem) -> Vec<StreamResponse> {
        let transcript = revision
            .words
            .iter()
            .map(|word| word.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        Self::parse_turn_with_correction(
            TurnMessage {
                turn_order: revision.turn_order,
                turn_is_formatted: true,
                end_of_turn: true,
                transcript,
                speaker_label: revision.speaker_label,
                utterance: None,
                language_code: None,
                language_confidence: None,
                end_of_turn_confidence: 0.0,
                words: revision.words,
            },
            ProviderTurnCorrectionKind::Replacement,
        )
    }

    fn parse_turn_with_correction(
        turn: TurnMessage,
        correction_kind: ProviderTurnCorrectionKind,
    ) -> Vec<StreamResponse> {
        tracing::debug!(
            transcript = %turn.transcript,
            utterance = ?turn.utterance,
            words_len = turn.words.len(),
            turn_is_formatted = turn.turn_is_formatted,
            end_of_turn = turn.end_of_turn,
            "assemblyai_turn_received"
        );

        if turn.transcript.is_empty() && turn.words.is_empty() {
            return vec![];
        }

        let is_final = turn.turn_is_formatted || turn.end_of_turn;
        let speech_final = turn.end_of_turn;
        let from_finalize = false;
        let turn_speaker = Self::parse_speaker_label(turn.speaker_label.as_deref());

        let words: Vec<_> = turn
            .words
            .iter()
            .filter(|w| w.word_is_final)
            .map(|w| {
                let speaker = match &w.speaker {
                    WordSpeaker::Missing => turn_speaker,
                    WordSpeaker::Explicit(Some(label)) => Self::parse_speaker_label(Some(label)),
                    WordSpeaker::Explicit(None) => None,
                };
                WordBuilder::new(&w.text)
                    .start(ms_to_secs(w.start))
                    .end(ms_to_secs(w.end))
                    .confidence(w.confidence)
                    .speaker(speaker)
                    .language(turn.language_code.clone())
                    .build()
            })
            .collect();

        let (start, duration) = calculate_time_span(&words);

        let transcript = if turn.turn_is_formatted {
            turn.transcript.clone()
        } else if let Some(ref utt) = turn.utterance {
            if !utt.is_empty() {
                utt.clone()
            } else if !turn.transcript.is_empty() {
                turn.transcript.clone()
            } else {
                words
                    .iter()
                    .map(|w| w.word.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            }
        } else if !turn.transcript.is_empty() {
            turn.transcript.clone()
        } else {
            words
                .iter()
                .map(|w| w.word.as_str())
                .collect::<Vec<_>>()
                .join(" ")
        };

        let channel = Channel {
            alternatives: vec![Alternatives {
                transcript,
                words,
                confidence: turn.end_of_turn_confidence,
                languages: turn.language_code.map(|l| vec![l]).unwrap_or_default(),
            }],
        };

        let mut metadata = Metadata::default();
        if is_final {
            metadata.set_provider_turn_correction(ProviderTurnCorrection {
                turn_order: turn.turn_order,
                kind: correction_kind,
            });
        }

        vec![StreamResponse::TranscriptResponse {
            is_final,
            speech_final,
            from_finalize,
            start,
            duration,
            channel,
            metadata,
            channel_index: vec![0, 1],
        }]
    }
}

impl ResolvedLiveModel {
    fn streaming_languages(self) -> &'static [&'static str] {
        match self {
            Self::Universal35Pro => U35_STREAMING_LANGUAGES,
            Self::U3RtPro => U3_STREAMING_LANGUAGES,
            Self::WhisperRt => &[],
        }
    }

    fn query_config(self, params: &ListenParams) -> (&'static str, bool) {
        match self {
            Self::Universal35Pro => ("universal-3-5-pro", params.languages.len() > 1),
            Self::U3RtPro => ("u3-rt-pro", params.languages.len() > 1),
            Self::WhisperRt => ("whisper-rt", params.languages.len() > 1),
        }
    }
}

#[cfg(test)]
mod tests {
    use anlg_language::ISO639;
    use owhisper_interface::ListenParams;
    use owhisper_interface::stream::{
        ProviderTurnCorrection, ProviderTurnCorrectionKind, StreamResponse,
    };

    use super::{AssemblyAIAdapter, AssemblyAIWord, ResolvedLiveModel, TurnMessage, WordSpeaker};
    use crate::ListenClient;
    use crate::adapter::RealtimeSttAdapter;
    use crate::test_utils::{UrlTestCase, run_dual_test, run_single_test, run_url_test_cases};

    const API_BASE: &str = "https://api.assemblyai.com";

    #[test]
    fn test_english_urls() {
        run_url_test_cases(
            &AssemblyAIAdapter::default(),
            API_BASE,
            &[
                UrlTestCase {
                    name: "english_only",
                    model: None,
                    languages: &[ISO639::En],
                    contains: &["speech_model=universal-3-5-pro"],
                    not_contains: &["format_turns", "language=", "language_detection"],
                },
                UrlTestCase {
                    name: "empty_defaults_to_english",
                    model: None,
                    languages: &[],
                    contains: &["speech_model=universal-3-5-pro"],
                    not_contains: &["format_turns", "language=", "language_detection"],
                },
            ],
        );
    }

    #[test]
    fn test_multilingual_urls() {
        run_url_test_cases(
            &AssemblyAIAdapter::default(),
            API_BASE,
            &[
                UrlTestCase {
                    name: "explicit_supported_language_keeps_u35",
                    model: Some("universal-3-5-pro-realtime"),
                    languages: &[ISO639::Es],
                    contains: &["speech_model=universal-3-5-pro"],
                    not_contains: &["format_turns", "language=", "speech_model=whisper-rt"],
                },
                UrlTestCase {
                    name: "legacy_u3_model_keeps_u3",
                    model: Some("u3-rt-pro"),
                    languages: &[ISO639::Es],
                    contains: &["speech_model=u3-rt-pro"],
                    not_contains: &["format_turns", "language=", "speech_model=whisper-rt"],
                },
                UrlTestCase {
                    name: "supported_multi_language_keeps_u35",
                    model: None,
                    languages: &[ISO639::En, ISO639::Es],
                    contains: &["speech_model=universal-3-5-pro", "language_detection=true"],
                    not_contains: &["format_turns", "language=", "speech_model=whisper-rt"],
                },
                UrlTestCase {
                    name: "u35_language_outside_legacy_u3_keeps_u35",
                    model: Some("universal-3-5-pro-realtime"),
                    languages: &[ISO639::Ja],
                    contains: &["speech_model=universal-3-5-pro"],
                    not_contains: &["format_turns", "language=", "speech_model=whisper-rt"],
                },
                UrlTestCase {
                    name: "unsupported_single_language_falls_back_to_whisper",
                    model: None,
                    languages: &[ISO639::Ko],
                    contains: &["speech_model=whisper-rt", "format_turns=true"],
                    not_contains: &["language=", "speaker_labels", "max_speakers"],
                },
                UrlTestCase {
                    name: "mixed_supported_and_unsupported_languages_fall_back_to_whisper",
                    model: None,
                    languages: &[ISO639::En, ISO639::Ko],
                    contains: &[
                        "speech_model=whisper-rt",
                        "format_turns=true",
                        "language_detection=true",
                    ],
                    not_contains: &["language=", "speaker_labels", "max_speakers"],
                },
            ],
        );
    }

    #[test]
    fn test_streaming_diarization_query_params() {
        let url = AssemblyAIAdapter.build_ws_url(
            API_BASE,
            &owhisper_interface::ListenParams {
                model: Some("universal-3-5-pro-realtime".to_string()),
                num_speakers: Some(3),
                ..Default::default()
            },
            1,
        );

        let query = url.query().expect("query string");
        assert!(query.contains("speaker_labels=true"));
        assert!(query.contains("max_speakers=3"));
    }

    #[test]
    fn test_streaming_min_speakers_enables_diarization() {
        let url = AssemblyAIAdapter.build_ws_url(
            API_BASE,
            &owhisper_interface::ListenParams {
                model: Some("universal-3-5-pro-realtime".to_string()),
                min_speakers: Some(2),
                ..Default::default()
            },
            1,
        );

        let query = url.query().expect("query string");
        assert!(query.contains("speaker_labels=true"));
        assert!(!query.contains("max_speakers"));
    }

    #[test]
    fn test_streaming_diarization_without_speaker_count() {
        let url = AssemblyAIAdapter.build_ws_url(
            API_BASE,
            &owhisper_interface::ListenParams {
                model: Some("universal-3-5-pro-realtime".to_string()),
                ..Default::default()
            },
            1,
        );

        let query = url.query().expect("query string");
        assert!(query.contains("speaker_labels=true"));
        assert!(!query.contains("max_speakers"));
    }

    #[test]
    fn test_streaming_diarization_hints_skip_whisper_fallback() {
        let url = AssemblyAIAdapter.build_ws_url(
            API_BASE,
            &owhisper_interface::ListenParams {
                num_speakers: Some(3),
                languages: vec![ISO639::Ko.into()],
                ..Default::default()
            },
            1,
        );

        let query = url.query().expect("query string");
        assert!(query.contains("speech_model=whisper-rt"));
        assert!(!query.contains("speaker_labels"));
        assert!(!query.contains("max_speakers"));
    }

    #[test]
    fn test_language_support_uses_whisper_fallback() {
        assert!(AssemblyAIAdapter::language_support_live(&[ISO639::Ko.into()]).is_supported());
        assert!(
            AssemblyAIAdapter::language_support_live(&[ISO639::En.into(), ISO639::Ko.into(),])
                .is_supported()
        );
    }

    #[test]
    fn test_resolve_live_model_prefers_u35_then_whisper_fallback() {
        assert_eq!(
            AssemblyAIAdapter::resolve_live_model(&ListenParams::default()),
            ResolvedLiveModel::Universal35Pro
        );
        assert_eq!(
            AssemblyAIAdapter::resolve_live_model(&ListenParams {
                languages: vec![ISO639::Es.into()],
                ..Default::default()
            }),
            ResolvedLiveModel::Universal35Pro
        );
        assert_eq!(
            AssemblyAIAdapter::resolve_live_model(&ListenParams {
                languages: vec![ISO639::Ja.into()],
                ..Default::default()
            }),
            ResolvedLiveModel::Universal35Pro
        );
        assert_eq!(
            AssemblyAIAdapter::resolve_live_model(&ListenParams {
                model: Some("u3-rt-pro".to_string()),
                languages: vec![ISO639::Ja.into()],
                ..Default::default()
            }),
            ResolvedLiveModel::WhisperRt
        );
        assert_eq!(
            AssemblyAIAdapter::resolve_live_model(&ListenParams {
                languages: vec![ISO639::Ko.into()],
                ..Default::default()
            }),
            ResolvedLiveModel::WhisperRt
        );
        assert_eq!(
            AssemblyAIAdapter::resolve_live_model(&ListenParams {
                model: Some("whisper-rt".to_string()),
                languages: vec![ISO639::En.into()],
                ..Default::default()
            }),
            ResolvedLiveModel::WhisperRt
        );
    }

    #[test]
    fn parse_turn_maps_speaker_labels_to_word_speakers() {
        let responses = AssemblyAIAdapter::parse_turn(TurnMessage {
            turn_order: 1,
            turn_is_formatted: true,
            end_of_turn: true,
            transcript: "Hello there".to_string(),
            speaker_label: Some("B".to_string()),
            utterance: None,
            language_code: Some("en".to_string()),
            language_confidence: None,
            end_of_turn_confidence: 0.99,
            words: vec![AssemblyAIWord {
                text: "Hello".to_string(),
                start: 0,
                end: 500,
                confidence: 0.9,
                word_is_final: true,
                speaker: WordSpeaker::Missing,
            }],
        });

        let StreamResponse::TranscriptResponse { channel, .. } = &responses[0] else {
            panic!("expected transcript response");
        };

        assert_eq!(channel.alternatives[0].words[0].speaker, Some(1));
    }

    #[test]
    fn parse_response_preserves_word_speaker_changes_within_one_turn() {
        let responses = AssemblyAIAdapter.parse_response(
            r#"{
                "type": "Turn",
                "turn_order": 2,
                "turn_is_formatted": true,
                "end_of_turn": true,
                "transcript": "Hello there",
                "speaker_label": "A",
                "end_of_turn_confidence": 0.99,
                "words": [
                    {"text":"Hello","start":0,"end":500,"confidence":0.9,"word_is_final":true,"speaker":"A"},
                    {"text":"there","start":500,"end":900,"confidence":0.9,"word_is_final":true,"speaker":"B"}
                ]
            }"#,
        );

        let StreamResponse::TranscriptResponse {
            channel, metadata, ..
        } = &responses[0]
        else {
            panic!("expected transcript response");
        };

        assert_eq!(
            channel.alternatives[0]
                .words
                .iter()
                .map(|word| word.speaker)
                .collect::<Vec<_>>(),
            vec![Some(0), Some(1)]
        );
        assert_eq!(
            metadata.provider_turn_correction(),
            Some(ProviderTurnCorrection {
                turn_order: 2,
                kind: ProviderTurnCorrectionKind::Pending,
            })
        );
    }

    #[test]
    fn parse_response_falls_back_only_when_word_speaker_is_absent() {
        let responses = AssemblyAIAdapter.parse_response(
            r#"{
                "type": "Turn",
                "turn_order": 3,
                "turn_is_formatted": true,
                "end_of_turn": true,
                "transcript": "Fallback null malformed",
                "speaker_label": "B",
                "words": [
                    {"text":"Fallback","start":0,"end":500,"confidence":0.9,"word_is_final":true},
                    {"text":"null","start":500,"end":700,"confidence":0.9,"word_is_final":true,"speaker":null},
                    {"text":"malformed","start":700,"end":900,"confidence":0.9,"word_is_final":true,"speaker":"PENDING"}
                ]
            }"#,
        );

        let StreamResponse::TranscriptResponse { channel, .. } = &responses[0] else {
            panic!("expected transcript response");
        };

        assert_eq!(
            channel.alternatives[0]
                .words
                .iter()
                .map(|word| word.speaker)
                .collect::<Vec<_>>(),
            vec![Some(1), None, None]
        );
        assert_eq!(
            channel.alternatives[0].transcript,
            "Fallback null malformed"
        );
    }

    #[test]
    fn parse_response_treats_unassigned_labels_as_anonymous() {
        for label in ["PENDING", "UNKNOWN", "", "AA", "speaker-a", "1"] {
            let raw = serde_json::json!({
                "type": "Turn",
                "turn_order": 4,
                "turn_is_formatted": true,
                "end_of_turn": true,
                "transcript": "Still here",
                "speaker_label": label,
                "words": [{
                    "text": "Still",
                    "start": 0,
                    "end": 500,
                    "confidence": 0.9,
                    "word_is_final": true,
                    "speaker": label,
                }],
            });

            let responses = AssemblyAIAdapter.parse_response(&raw.to_string());
            let StreamResponse::TranscriptResponse { channel, .. } = &responses[0] else {
                panic!("expected transcript response");
            };

            assert_eq!(channel.alternatives[0].words[0].speaker, None, "{label}");
            assert_eq!(channel.alternatives[0].transcript, "Still here");
        }
    }

    #[test]
    fn parse_response_keeps_text_for_non_string_speaker_metadata() {
        let responses = AssemblyAIAdapter.parse_response(
            r#"{
                "type": "Turn",
                "turn_order": 5,
                "turn_is_formatted": true,
                "end_of_turn": true,
                "transcript": "Still all here",
                "speaker_label": {"unexpected": "value"},
                "words": [
                    {"text":"Still","start":0,"end":200,"confidence":0.9,"word_is_final":true,"speaker":1},
                    {"text":"all","start":200,"end":400,"confidence":0.9,"word_is_final":true,"speaker":false},
                    {"text":"here","start":400,"end":600,"confidence":0.9,"word_is_final":true,"speaker":[]}
                ]
            }"#,
        );

        let StreamResponse::TranscriptResponse { channel, .. } = &responses[0] else {
            panic!("expected transcript response");
        };

        assert_eq!(channel.alternatives[0].transcript, "Still all here");
        assert_eq!(
            channel.alternatives[0]
                .words
                .iter()
                .map(|word| word.speaker)
                .collect::<Vec<_>>(),
            vec![None, None, None]
        );
    }

    #[test]
    fn parse_response_emits_speaker_revisions_for_matching_turns() {
        let responses = AssemblyAIAdapter.parse_response(
            r#"{
                "type": "SpeakerRevision",
                "revisions": [{
                    "turn_order": 3,
                    "speaker_label": "B",
                    "words": [
                        {"text":"Hello","start":1000,"end":1200,"confidence":0.9,"word_is_final":true,"speaker":"B"},
                        {"text":"there","start":1200,"end":1500,"confidence":0.9,"word_is_final":true,"speaker":"A"}
                    ]
                }]
            }"#,
        );

        let StreamResponse::TranscriptResponse {
            channel, metadata, ..
        } = &responses[0]
        else {
            panic!("expected transcript response");
        };

        assert_eq!(channel.alternatives[0].transcript, "Hello there");
        assert_eq!(
            channel.alternatives[0]
                .words
                .iter()
                .map(|word| word.speaker)
                .collect::<Vec<_>>(),
            vec![Some(1), Some(0)]
        );
        assert_eq!(
            metadata.provider_turn_correction(),
            Some(ProviderTurnCorrection {
                turn_order: 3,
                kind: ProviderTurnCorrectionKind::Replacement,
            })
        );
    }

    macro_rules! single_test {
        ($name:ident, $params:expr) => {
            #[tokio::test]
            #[ignore]
            async fn $name() {
                let client = ListenClient::builder()
                    .adapter::<AssemblyAIAdapter>()
                    .api_base("wss://streaming.assemblyai.com")
                    .api_key(
                        std::env::var("ASSEMBLYAI_API_KEY").expect("ASSEMBLYAI_API_KEY not set"),
                    )
                    .params($params)
                    .build_single()
                    .await
                    .unwrap();
                run_single_test(client, "assemblyai").await;
            }
        };
    }

    single_test!(
        test_build_single,
        owhisper_interface::ListenParams {
            model: Some("u3-rt-pro".to_string()),
            languages: vec![anlg_language::ISO639::En.into()],
            ..Default::default()
        }
    );

    single_test!(
        test_single_with_keywords,
        owhisper_interface::ListenParams {
            model: Some("u3-rt-pro".to_string()),
            languages: vec![anlg_language::ISO639::En.into()],
            keywords: vec!["Anarlog".to_string(), "transcription".to_string()],
            ..Default::default()
        }
    );

    single_test!(
        test_single_multi_lang_1,
        owhisper_interface::ListenParams {
            model: Some("u3-rt-pro".to_string()),
            languages: vec![
                anlg_language::ISO639::En.into(),
                anlg_language::ISO639::Es.into(),
            ],
            ..Default::default()
        }
    );

    single_test!(
        test_single_multi_lang_2,
        owhisper_interface::ListenParams {
            model: Some("whisper-rt".to_string()),
            languages: vec![
                anlg_language::ISO639::En.into(),
                anlg_language::ISO639::Ko.into(),
            ],
            ..Default::default()
        }
    );

    #[tokio::test]
    #[ignore]
    async fn test_build_dual() {
        let client = ListenClient::builder()
            .adapter::<AssemblyAIAdapter>()
            .api_base("wss://streaming.assemblyai.com")
            .api_key(std::env::var("ASSEMBLYAI_API_KEY").expect("ASSEMBLYAI_API_KEY not set"))
            .params(owhisper_interface::ListenParams {
                model: Some("u3-rt-pro".to_string()),
                languages: vec![anlg_language::ISO639::En.into()],
                ..Default::default()
            })
            .build_dual()
            .await
            .unwrap();

        run_dual_test(client, "assemblyai").await;
    }
}
