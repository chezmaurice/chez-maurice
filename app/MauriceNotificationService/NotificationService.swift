import UserNotifications

/// Opens a sealed push before it is shown. A household encrypts each push to
/// this device's keys (Shared/PushSeal.swift), so what Apple carries is "New
/// message" and a blob; here the blob becomes the real title and text, and the
/// conversation and household the tap opens. A push that is not sealed, or
/// that this device cannot open, is shown as it came.
final class NotificationService: UNNotificationServiceExtension {
    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent,
              let sealed = content.userInfo["sealed"] as? String,
              let opened = PushSeal.open(sealed) else {
            contentHandler(request.content)
            return
        }
        if let title = opened["title"] as? String { content.title = title }
        if let body = opened["body"] as? String { content.body = body }
        var info = content.userInfo
        info["sealed"] = nil
        for key in ["conversationId", "householdTag"] {
            if let value = opened[key] as? String { info[key] = value }
        }
        content.userInfo = info
        contentHandler(content)
    }
}
