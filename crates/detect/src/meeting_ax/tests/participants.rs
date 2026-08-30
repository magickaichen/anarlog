use super::*;

#[test]
fn zoom_fixture_extracts_normalized_participant_names() {
    let nodes = [
        fixture_node(0, "AXButton", "Leave meeting", &[0, 0]),
        fixture_node(
            1,
            "AXGroup",
            "Video render   Ada Lovelace (You), Computer audio unmuted",
            &[0, 1],
        ),
        fixture_node(
            2,
            "AXGroup",
            "Video render Grace Hopper, Computer audio muted",
            &[0, 2],
        ),
    ];

    assert_eq!(
        extract_observed_participants(&MeetingPlatform::Zoom, &nodes),
        vec![
            MeetingObservedParticipant {
                display_name: "Ada Lovelace".to_string(),
            },
            MeetingObservedParticipant {
                display_name: "Grace Hopper".to_string(),
            },
        ]
    );
}

#[test]
fn google_meet_fixture_extracts_names_only_from_people_surface() {
    let people = fixture_node(0, "AXGroup", "People", &[4]);
    let mut ada = fixture_node(1, "AXStaticText", "  Ada   Lovelace  ", &[4, 0, 0]);
    ada.identifier = Some("participant-name".to_string());
    let mut grace = fixture_node(2, "AXStaticText", "Grace Hopper (You)", &[4, 1, 0]);
    grace.identifier = Some("participant-name".to_string());
    let email = fixture_node(3, "AXStaticText", "ada@example.com", &[4, 0, 1]);
    let chat_sender = fixture_node(4, "AXStaticText", "Chat Sender", &[8, 0]);

    assert_eq!(
        extract_observed_participants(
            &MeetingPlatform::GoogleMeet,
            &[people, ada, grace, email, chat_sender],
        ),
        vec![
            MeetingObservedParticipant {
                display_name: "Ada Lovelace".to_string(),
            },
            MeetingObservedParticipant {
                display_name: "Grace Hopper".to_string(),
            },
        ]
    );
}

#[test]
fn teams_fixture_extracts_and_deduplicates_roster_names() {
    let roster = fixture_node(0, "AXList", "Participants", &[6]);
    let mut first = fixture_node(1, "AXStaticText", "Katherine Johnson", &[6, 0, 0]);
    first.identifier = Some("roster-participant-name".to_string());
    let mut repeated = fixture_node(2, "AXStaticText", "katherine  johnson", &[6, 1, 0]);
    repeated.identifier = Some("roster-participant-name".to_string());
    let title = fixture_node(3, "AXStaticText", "Flight Dynamics Lead", &[6, 0, 1]);

    assert_eq!(
        extract_observed_participants(
            &MeetingPlatform::MicrosoftTeams,
            &[roster, first, repeated, title],
        ),
        vec![MeetingObservedParticipant {
            display_name: "Katherine Johnson".to_string(),
        }]
    );
}
