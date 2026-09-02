use std::collections::HashSet;

use super::{AxNode, MeetingObservedParticipant, MeetingPlatform, node_labels};

pub(super) fn extract_observed_participants(
    platform: &MeetingPlatform,
    nodes: &[AxNode],
) -> Vec<MeetingObservedParticipant> {
    let mut seen = HashSet::new();
    let mut participants = Vec::new();
    let participant_scopes = participant_scope_paths(platform, nodes);

    for node in nodes {
        let display_name = match platform {
            MeetingPlatform::Zoom => node_labels(node).find_map(zoom_participant_name),
            MeetingPlatform::GoogleMeet | MeetingPlatform::MicrosoftTeams => {
                scoped_participant_name(node, &participant_scopes)
            }
            _ => None,
        };
        let Some(display_name) = display_name else {
            continue;
        };
        if seen.insert(display_name.to_lowercase()) {
            participants.push(MeetingObservedParticipant { display_name });
        }
    }

    participants
}

pub(super) fn supports_observed_participant_capture(platform: &MeetingPlatform) -> bool {
    matches!(
        platform,
        MeetingPlatform::Zoom | MeetingPlatform::GoogleMeet | MeetingPlatform::MicrosoftTeams
    )
}

fn participant_scope_paths(platform: &MeetingPlatform, nodes: &[AxNode]) -> Vec<Vec<usize>> {
    if !matches!(
        platform,
        MeetingPlatform::GoogleMeet | MeetingPlatform::MicrosoftTeams
    ) {
        return Vec::new();
    }

    nodes
        .iter()
        .filter(|node| {
            matches!(
                node.role.as_deref(),
                Some("AXGroup") | Some("AXList") | Some("AXScrollArea") | Some("AXTable")
            ) && node_labels(node).any(|label| {
                matches!(
                    label.trim().to_ascii_lowercase().as_str(),
                    "people" | "participants" | "participant list" | "roster"
                )
            })
        })
        .map(|node| node.tree_path.clone())
        .collect()
}

fn scoped_participant_name(node: &AxNode, scope_paths: &[Vec<usize>]) -> Option<String> {
    let identifier = node.identifier.as_deref()?.to_ascii_lowercase();
    if !identifier.contains("participant-name")
        || !scope_paths
            .iter()
            .any(|scope| node.tree_path.len() > scope.len() && node.tree_path.starts_with(scope))
    {
        return None;
    }

    node_labels(node).find_map(normalize_display_name)
}

fn zoom_participant_name(label: &str) -> Option<String> {
    let label = label.trim();
    let remainder = label.strip_prefix("Video render ")?;
    normalize_display_name(remainder.split(',').next()?)
}

fn normalize_display_name(value: &str) -> Option<String> {
    let mut normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    for suffix in [" (You)", " (you)", " (Me)", " (me)"] {
        if normalized.ends_with(suffix) {
            normalized.truncate(normalized.len() - suffix.len());
            normalized = normalized.trim().to_string();
        }
    }

    (!normalized.is_empty() && normalized.len() <= 160 && !normalized.contains('@'))
        .then_some(normalized)
}
