import AppKit
import GoogleSignIn
import PagerKit
import SwiftUI

struct SignInWindow: View {
    static let id = "signin"
    let services: AppServices
    @Environment(\.dismissWindow) private var dismissWindow
    @State private var error: String?
    @State private var isWorking = false

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "dot.radiowaves.left.and.right")
                .font(.system(size: 44))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("Pocket Pager").font(.title.bold())
            Text("Sign in to get paged on this Mac.")
                .foregroundStyle(.secondary)
            if let error {
                Text(error)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            Button("Sign in with Google") { Task { await signIn() } }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(isWorking)
        }
        .padding(32)
        .frame(width: 360)
        .onAppear { NSApp.activate() }
    }

    private func signIn() async {
        isWorking = true
        defer { isWorking = false }
        guard let window = NSApp.keyWindow ?? NSApp.windows.first(where: \.isVisible) else {
            error = "Couldn't open the Google sign-in window. Try again."
            return
        }
        do {
            let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: window)
            guard let idToken = result.user.idToken?.tokenString else {
                error = "Google didn't return an identity token. Please try again."
                return
            }
            do {
                try await services.signIn(idToken: idToken)
            } catch {
                GIDSignIn.sharedInstance.signOut() // the next attempt starts clean
                throw error
            }
            await services.permission.request()
            LoginItem.set(true) // a pager that isn't running can't show its menu
            dismissWindow(id: Self.id)
        } catch let googleError as GIDSignInError where googleError.code == .canceled {
            // Closed the Google window: stay here.
        } catch {
            self.error = (error as? APIError)?.message ?? error.localizedDescription
        }
    }
}
