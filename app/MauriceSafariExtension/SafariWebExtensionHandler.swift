import Foundation
import SafariServices

/// The native half of the Safari extension (the web half is
/// clients/web-clipper, the same code as in Chrome and Firefox). Its popup
/// asks one thing — `{type: "session"}` — and is answered with the session the
/// app published (BrowserSession), or nothing when no one is signed in, in
/// which case the popup offers to connect with a code like any browser.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any]

        var reply: [String: Any] = [:]
        if message?["type"] as? String == "session", let session = BrowserSession.read() {
            reply["serverUrl"] = session.serverUrl
            reply["token"] = session.token
            if let household = session.household { reply["household"] = household }
            if let member = session.member {
                var who: [String: Any] = ["name": member.name]
                if let color = member.color { who["color"] = color }
                reply["member"] = who
            }
        }

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: reply]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
