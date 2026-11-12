import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import { ThemeProvider } from "../ui/ThemeContext";
import { SignIn } from "./SignIn";

// A school admin has a real email and no login ID, so the phone's sign-in has to take an email too.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
jest.mock("@figbloom/shared", () => ({ ...jest.requireActual("@figbloom/shared"), supabase: jest.fn() }));

const supabase = shared.supabase as unknown as jest.Mock;
const signInWithPassword = jest.fn();
const resetPasswordForEmail = jest.fn();

beforeEach(() => {
  signInWithPassword.mockReset().mockResolvedValue({ error: null });
  resetPasswordForEmail.mockReset().mockResolvedValue({ error: null });
  supabase.mockReset().mockReturnValue({ auth: { signInWithPassword, resetPasswordForEmail } });
});

async function openEmailMode(props: { unsupportedAtStart?: boolean } = {}) {
  render(<ThemeProvider><SignIn {...props} /></ThemeProvider>);
  fireEvent.press(await screen.findByText("School admin? Sign in with your email"));
}

describe("signing in with an email", () => {
  it("is offered under the school and ID form, and swaps it for an email and a password", async () => {
    await openEmailMode();
    expect(screen.getByText("School admins sign in with the email they were set up with.")).toBeTruthy();
    expect(screen.getByPlaceholderText("you@school.sc.ke")).toBeTruthy();
    expect(screen.getByPlaceholderText("••••••••")).toBeTruthy();
    expect(screen.queryByText("School")).toBeNull();
    expect(screen.queryByText("Your ID")).toBeNull();
  });

  it("signs in with exactly the email and password typed", async () => {
    await openEmailMode();
    fireEvent.changeText(screen.getByPlaceholderText("you@school.sc.ke"), "  grace@kijani.sc.ke ");
    fireEvent.changeText(screen.getByPlaceholderText("••••••••"), "s3cret-pass");
    await act(async () => { fireEvent.press(screen.getByText("Sign in")); });
    expect(signInWithPassword).toHaveBeenCalledWith({ email: "grace@kijani.sc.ke", password: "s3cret-pass" });
  });

  it("does not offer Sign in until there is an email and a password", async () => {
    await openEmailMode();
    await act(async () => { fireEvent.press(screen.getByText("Sign in")); });
    expect(signInWithPassword).not.toHaveBeenCalled();
    fireEvent.changeText(screen.getByPlaceholderText("you@school.sc.ke"), "grace@kijani.sc.ke");
    await act(async () => { fireEvent.press(screen.getByText("Sign in")); });
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("says the email or password is wrong, without saying which", async () => {
    signInWithPassword.mockResolvedValue({ error: { name: "AuthApiError", message: "Invalid login credentials", status: 400 } });
    await openEmailMode();
    fireEvent.changeText(screen.getByPlaceholderText("you@school.sc.ke"), "grace@kijani.sc.ke");
    fireEvent.changeText(screen.getByPlaceholderText("••••••••"), "wrong");
    await act(async () => { fireEvent.press(screen.getByText("Sign in")); });
    expect(await screen.findByText("Check the email and password.")).toBeTruthy();
  });

  it("emails a reset link that opens the web's reset page, and does not say whether the address has an account", async () => {
    await openEmailMode();
    fireEvent.press(screen.getByText("Forgot password?"));
    fireEvent.changeText(screen.getByPlaceholderText("you@school.sc.ke"), "grace@kijani.sc.ke");
    await act(async () => { fireEvent.press(screen.getByText("Email me a link")); });
    expect(resetPasswordForEmail).toHaveBeenCalledWith("grace@kijani.sc.ke", { redirectTo: "https://schoolmanagement.figbloom.org/reset-password" });
    expect(await screen.findByText("If that email has an account, a link to choose a new password is on its way.")).toBeTruthy();
  });

  it("goes back to the school and ID form", async () => {
    await openEmailMode();
    fireEvent.press(screen.getByText("Sign in with your school ID instead"));
    expect(screen.getByText("Sign in with the login your school gave you.")).toBeTruthy();
    expect(screen.getByText("School")).toBeTruthy();
  });

  it("tells someone whose account has no screens in the app yet, until they start typing", async () => {
    render(<ThemeProvider><SignIn unsupportedAtStart /></ThemeProvider>);
    expect(await screen.findByText("Not on the phone yet")).toBeTruthy();
    fireEvent.press(screen.getByText("School admin? Sign in with your email"));
    expect(screen.queryByText("Not on the phone yet")).toBeNull();
  });
});
