# Salesforce Site Package.xml Generator

Pick an Experience Cloud site and get a `package.xml` for the site and everything it depends on. Add any other metadata from the org on top.

## What it collects

Starting from the site you pick, it follows references until nothing new turns up:

| Source | What is found |
|---|---|
| The site itself | `Network`, `CustomSite`, `DigitalExperienceConfig`, `DigitalExperienceBundle` (`site/…`) or `ExperienceBundle` for Aura sites, `NetworkBranding`, `NavigationMenu`, `Audience`, `ManagedTopics` |
| CMS | `DigitalExperienceBundle` (`content/…`) for each enhanced CMS workspace that publishes to the site, and the custom `ManagedContentType`s it uses |
| Site pages and theme | LWC and Aura components placed on pages, embedded flows, static resources linked in head markup, trusted sites (CSP) |
| LWC / Aura | Child components, Apex classes, static resources, custom labels, objects, message channels, custom permissions, content assets |
| Apex | Other Apex classes, named credentials and their external credentials, custom objects, custom settings, custom metadata types and their records, labels, flows, matching test classes |
| Site settings | Visualforce pages, email templates and permission sets set on the site |

### What is ticked by default

Everything found is ticked, except:

- **Covered by the site bundle:** `Network`, `Audience` and `CspTrustedSite`. They are listed, unticked; tick them (or run the command line with `--include-covered`) when you need them, for example to create the site in a fresh org.
- The standard `Communities*` Visualforce pages and default email templates.

The guest user profile is never included, and no `Profile` is ever written.

> Changed in 0.3: `Network`, `Audience` and trusted sites used to be ticked. Default manifests are now smaller.

## Use

1. Open a Salesforce DX project with a default org authorised.
2. Command palette → **Site Package.xml Generator: Choose Site**.
3. Pick a site. Collection takes about four minutes the first time because the org's metadata is indexed; a second site in the same panel is faster.
4. Review the list. The left pane groups components by type, the middle pane lists the selected group with the reason each item was included, and the right pane previews the manifest as you tick.
5. Then:
   - **Write manifest** → `manifest/package-<site>.xml`
   - **Copy XML**
   - **Retrieve from org** → writes the manifest and runs `sf project retrieve start` in a terminal, after confirmation
   - **Overwrite package.xml** → replaces `manifest/package.xml`

### Adding metadata the site does not use

- **View all in org** (in a group's header) lists every component of that type in the org below the site's own, unticked. Long lists show 300 rows at a time; the filter searches the whole list.
- **Other metadata types in the org** are all listed at the bottom of the groups pane. Their components are only fetched when you click one. **Add from org…** opens the same list as a searchable picker.
- **Add dependencies** appears once you tick a Lightning, Aura, Apex, Visualforce or Flow component by hand. It scans those components and ticks what they need.
- Components you add by hand are remembered per org and site and ticked again after the next scan.

The extension only reads from the org. Scanning retrieves source into a temporary folder that is deleted afterwards; your project files are untouched until you choose **Retrieve from org**.

### Command line

The same engine runs without VS Code, from inside an SFDX project:

```sh
node out/cli.js --list
node out/cli.js "my-site" --why --out manifest/package-my-site.xml
node out/cli.js "my-site" --include-covered
```

## Limits

- Apex and component references are found by reading source, so fully dynamic references (class names built at runtime, dynamic SOQL assembled from variables) can be missed. A cross-check against Salesforce's dependency API catches some of these.
- Standard objects, managed-package components, sharing sets, moderation rules and triggers on the collected objects are not found by the scan.
- Folder-based types (reports, dashboards, documents) cannot be listed through **Add from org**.
- Custom objects are added whole, not field by field.
- Salesforce retrieves at most 10,000 files at a time; very large manifests may need splitting.

## Develop

```sh
npm install
npm test        # build + scanner tests
npm run build   # then press F5 to launch the Extension Development Host
npm run package # build a .vsix
```

Requires the Salesforce CLI (`sf`) on your PATH, or set `sitePackageGen.sfPath`.

Developed by [Nitish Bhosale](https://www.linkedin.com/in/nitishbhosale07).
