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
            Image(systemName: "dot.radiowaves.left.and.right")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("Pocket Pager")
                .font(.largeTitle.bold())
            Text("Get paged on this iPhone when your scripts and agents need you.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Spacer()
            if let error {
                Text(error)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            Button {
                Task { await signIn() }
            } label: {
                Text("Sign in with Google").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(isWorking)
        }
        .padding(24)
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
