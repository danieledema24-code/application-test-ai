# nextjobquest.com: test case review

Project: `nextjobquest.com` (`cmw88ui3u0008jlr8xzqwhpl3`), application URL https://www.nextjobquest.com/
Reviewed: 2026-11-08. Covers 20 AI-generated cases (TC-0001 to TC-0020).
I checked each case against the live page HTML and the page JavaScript bundles, read-only. I did not submit any form or sign in.

The proposed PATCH bodies are in `case-updates.json`. Each body sets `title`, `description`, `preconditions`, `steps` and `expectedResult`. Category, priority and status are left as they were. Content edits bump the version, and the API moves TC-0001 from APPROVED back to DRAFT.

## Problems that affect every case

- **Relative paths only.** Steps say "Open /about". No step has an absolute URL.
- **Shallow steps.** Most cases have 2–3 steps, and expected results are vague, e.g. "The page loads completely" or "a loading state or redirect follows".
- **Thin preconditions.** "The application is reachable" is the only precondition. Browser, signed-out state, test account and live-site safety are never stated.
- **Template grammar.** Six expected results read "The the X page page opens". Titles repeat the path, e.g. "(/auth/signin)".
- **Wrong validation model.** Validation cases assume every empty field shows its own message. The site uses native HTML `required` / `type=email` validation, so the browser only flags the first invalid field. The rewrites check fields one at a time and confirm in DevTools Network that no request was sent.

## Per-case review

| Key | Title (new) | Main problems found | What changed |
|---|---|---|---|
| TC-0001 | Home page loads successfully with title, heading and main sections | Relative "/"; "The the home page page"; 3 steps; no HTTP or console check | Absolute URL; HTTP 200 and console checks; checks the "Sign up for free" link target, the real section headings and the footer; 9 steps |
| TC-0002 | Home page main heading "Land Interviews Faster" is visible and readable | 2 steps; "fully visible" can't be checked as written | Checks the exact text and subtitle, a single h1, 375 px width and 200% zoom; 8 steps |
| TC-0003 | About page loads successfully with title, heading and content | Relative path; grammar; no navigation check | Absolute URL; checks the "About Us" and "Our Principles" sections and the header "About Us" link; flags that the hero "Get Started" goes to /auth/signin while the header one goes to /auth/signup |
| TC-0004 | About page main heading "Who We Are" is visible and readable | 2 steps, vague | Same heading checklist as TC-0002, using the real subtitle |
| TC-0005 | Sign-in page loads successfully with heading and sign-in form | Relative path; grammar; ignored that the form is rendered client-side | Absolute URL; JavaScript-enabled precondition; checks the real elements ("Using Google?" notice, Email Address, Password, "Forgot your password?" → /auth/forgot-password, "Sign in", "Google", "Sign up") |
| TC-0006 | Sign-in page main heading "Welcome back" is visible and readable | 2 steps | Heading checklist with the subtitle "Sign in to your account to continue" |
| TC-0007 | Registered user can sign in with a valid email and password | Vague "Verify the user is signed in"; landing page not named; no session check | QA test-account precondition (email/password, not Google); "Signing in..." state; request to /api/auth/callback/credentials; redirect to https://www.nextjobquest.com/dashboard; session survives a reload; sign-out cleanup |
| TC-0008 | Sign-in form cannot be submitted with empty required fields | Expected an error on every field at once, but native validation flags only the first | Each field checked one at a time; Network check that nothing was sent; marked safe on live |
| TC-0009 | Sign-in is rejected for a valid email with a wrong password | "Error about invalid credentials" not specified; no session check | Red error box above the form; message must not reveal whether the account exists or show a raw code (e.g. "CredentialsSignin"); /dashboard must still redirect; warning about account lockout |
| TC-0010 | Sign-in form rejects an email address without @ | Password left empty, so two fields could fail; expected an inline message, but the browser shows a tooltip | Password filled so only the email is invalid; native-tooltip expectation; second invalid value "jane@"; Network check |
| TC-0011 | Sign-up page loads successfully with heading and registration form | Relative path; grammar | Absolute URL; real fields and placeholders, "Google", "Already have an account? Sign in"; label-to-field link; header "Get Started" navigation |
| TC-0012 | Sign-up page main heading "Create your account" is visible and readable | 2 steps | Heading checklist with the subtitle "Fill in your details to get started" |
| TC-0013 | New visitor can create an account with valid details | Fixed jane.doe@example.com fails as a duplicate on every rerun; "signed in or asked to confirm email" is a guess | Unique plus-address placeholder; "do not press Sign up on live without approval"; real "Account created successfully!" dialog → "Proceed" → https://www.nextjobquest.com/welcome; duplicate-email negative step; cleanup precondition |
| TC-0014 | Sign-up form cannot be submitted with empty required fields | Same native-validation mistake as TC-0008 | Full Name → Email Address → Password checked in order, never all three filled; Network check |
| TC-0015 | Sign-up form rejects an email address without @ | Only the email filled, so the browser would flag the empty Full Name first and the test would check the wrong thing | Name and password filled; stop-and-report rule if a POST /api/auth/signup is sent |
| TC-0016 | Sign-up "Full Name" field handles a 256-character name | Typo-prone 256 "A"s inside the action; "Sample text" as a password; a successful submit creates a real account | Paste step with the value in test data; checks 255/256/257 lengths via the console; mobile width; submit steps marked TEST ENVIRONMENT ONLY and must never return 5xx; cleanup |
| TC-0017 | Contact page loads successfully with heading and contact form | Wrong main heading: "Contact Us" is an h2 label, and the h1 is "Get in touch with our customer support centre"; grammar | Correct h1 and label; real form contents (placeholders, Gender select, newsletter Yes/No with No preselected); footer "Contact" navigation |
| TC-0018 | Contact page headings are visible and readable | Checked the wrong heading | Checks both texts; notes that the h2 comes before the h1 (heading-order accessibility issue) |
| TC-0019 | Contact form can be submitted with valid details and shows a confirmation | Nonsense steps: "Enter Sample text in the select-one / Yes / No field"; placeholder data | Real interactions (choose "Female", click the "Yes" radio); realistic data; no submit on live; known issue noted (see below) |
| TC-0020 | Contact form cannot be submitted with empty required fields | Assumes required fields exist; none are marked required | Field-by-field check plus invalid email; the required list (First Name, Last Name, Email) is labelled as an assumption to confirm with the product owner; known issue noted |

## Possible defects found on the live site

1. **Major: the contact form does nothing.** The `/contact` page's submit handler is just `e.preventDefault(); console.log(e)`. It sends no request, has no required fields and shows no confirmation. TC-0019 and TC-0020 keep their requirement-based expected results, so they are expected to fail and should be raised as defects.
2. **Minor: About hero "Get Started" goes to sign-in.** On https://www.nextjobquest.com/about it links to `/auth/signin`. Every other "Get Started" links to `/auth/signup`.
3. **Minor (accessibility): contact form has no labels.** Its inputs have only placeholders (no `<label>`). The "Contact Us" h2 comes before the page h1.
4. **Minor (SEO): every page has the same title.** All pages use "Nucrox – Land Interviews Faster", so the title checks pass but cannot tell pages apart.
5. **Minor (content): button name mismatch on sign-in.** The notice says to use the "Sign in with Google" button, but the button is labelled "Google".
