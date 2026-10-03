import GoogleSignIn
import PagerKit
import SwiftUI

struct SignInView: View {
    let services: AppServices
    @State private var error: String?
    @State private var isWorking = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image("Logo")
                .resizable()
                .frame(width: 120, height: 120)
                .clipShape(RoundedRectangle(cornerRadius: 27, style: .continuous))
                .shadow(color: Theme.orange.opacity(0.3), radius: 18, y: 8)
                .accessibilityHidden(true)
            Text("Pocket Pager")
                .font(.largeTitle.bold())
                .multilineTextAlignment(.center)
            Text("Get paged on this iPhone when your scripts and agents need you.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            PagerDisplay(label: "How it works", title: "curl -d \"Build finished\"", message: "your-url → this iPhone rings")
            Spacer()
            if let error {
                Text(error)
                    .foregroundStyle(Theme.bad)
                    .multilineTextAlignment(.center)
            }
            Button {
                Task { await signIn() }
            } label: {
                Text(isWorking ? "Signing in…" : "Sign in with Google")
            }
            .buttonStyle(SecondaryButtonStyle(strong: true))
            .disabled(isWorking)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
    }

    private func signIn() async {
        isWorking = true
        defer { isWorking = false }
        guard let presenter = UIApplication.shared.connectedScenes
            .compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController })
            .first
        else {
            error = "Couldn't open the Google sign-in window. Try again."
            return
        }
        do {
            let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: presenter)
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
            error = nil
            await services.permission.request()
        } catch let googleError as GIDSignInError where googleError.code == .canceled {
            // The user closed the Google sheet: stay quietly on this screen.
        } catch {
            self.error = (error as? APIError)?.message ?? error.localizedDescription
        }
    }
}
