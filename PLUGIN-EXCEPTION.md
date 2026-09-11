# Plugin exception

An additional permission under section 7 of the GNU Affero General Public
License, version 3 (`LICENSE`), granted by the copyright holder of only-chat.

It adds to the AGPL and takes nothing away from it. Anyone who does not meet
its conditions keeps every right the AGPL gives them — they simply do not get
this one on top.

## In one paragraph

Write a plugin for only-chat and you choose its licence, closed source
included, for any deployment that is not a Public Service: yourself, your
household, your friends, your team, your company. The moment an instance
running your plugin is offered to the public or to customers — paid or free —
this permission does not apply to that instance, and the whole instance,
plugin included, falls under the AGPL like any other modified version. Either
publish the plugin under the AGPL for that instance's users, or take a
commercial licence (`COMMERCIAL-LICENSING.md`).

## Definitions

**The Program** is only-chat as licensed under `LICENSE`, together with any
work based on it.

**A Plugin** is a body of code that meets all of the following:

1. It lives in a directory of its own under `src/plugins/<id>/`, or is supplied
   from outside the repository and loaded the way such a directory is.
2. It contains no code copied or adapted from the Program outside
   `src/plugins/`. Importing the Program's modules and calling them is fine;
   reproducing them is not.
3. Its only changes to the Program outside its own directory are its
   **Registration Entries**: the declarations that name the Plugin, its id and
   its tool ids in the Program's plugin registration lists (at the time of
   writing `src/shared/plugins.ts`, `src/shared/plugin-manifests.ts`,
   `src/client/plugins/loaders.ts` and `src/server/app.ts`).

Anything that fails one of these is a modification of the Program, not a
Plugin, whatever directory it sits in.

**A Public Service** is a running instance of the Program that is made
available to members of the general public (including through open or
request-based sign-up), or to customers, clients or other third parties as
part of a product or service — whether or not anyone pays for it.

An instance used only by you, the members of your household, people you
personally invite, or the members, employees and contractors of your own
organisation acting in that capacity, is not a Public Service.

## The permission

For any instance of the Program that is not a Public Service:

1. The AGPL's requirements to license a work under the AGPL and to provide or
   offer its Corresponding Source (sections 5(c), 6 and 13) do not extend to a
   Plugin combined with the Program. You need not offer the Plugin's source to
   that instance's users, and the Plugin need not be licensed under the AGPL.
2. You may convey a Plugin under terms of your choice, including proprietary
   terms, for use in such instances — on its own, or alongside a copy of the
   Program.

Registration Entries are covered by the same permission as the Plugin they
name.

## What it does not change

- **Everything other than the Plugin stays under the AGPL.** If you modify the
  Program itself, section 13 still applies to those modifications: offer them
  to the users of your instance. That obligation reaches only those users, not
  the public.
- **A Public Service gets no permission under this exception.** Its operator
  must meet the AGPL for the whole combination, Plugins included, or hold a
  commercial licence. A Plugin conveyed under proprietary terms therefore
  cannot be run in a Public Service unless its author licenses it for that.
- **Conveying the Program**, with or without Plugins, still requires its
  Corresponding Source under the AGPL; only the Plugins keep their own terms.
  Section 7 lets anyone who conveys a copy remove this exception from that
  copy.
- **This is a licence permission, not an API promise.** The Program's internal
  modules change without notice, and a Plugin that imports them may break.
- **The plugins that ship in `src/plugins/`** are licensed under MIT
  (`src/plugins/LICENSE`). That is a separate grant and does not depend on this
  exception.
