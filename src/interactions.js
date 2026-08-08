// Ephemeral interaction replies come with Discord's own "Only you can see
// this message" wrapper and a manual dismiss button. These helpers schedule
// automatic deletion instead, so users don't have to dismiss them by hand.
// Call right after whichever call actually sets the final visible content
// (reply()/editReply() for the primary response, followUp() for a
// secondary one) so the countdown starts when the user actually sees it,
// not from an earlier deferral.
const EPHEMERAL_DISMISS_MS = 5000;

function scheduleEphemeralDismiss(interaction, delayMs = EPHEMERAL_DISMISS_MS) {
  setTimeout(() => {
    interaction.deleteReply().catch(() => {});
  }, delayMs);
}

function scheduleFollowUpDismiss(interaction, message, delayMs = EPHEMERAL_DISMISS_MS) {
  setTimeout(() => {
    interaction.webhook.deleteMessage(message).catch(() => {});
  }, delayMs);
}

module.exports = { scheduleEphemeralDismiss, scheduleFollowUpDismiss };
