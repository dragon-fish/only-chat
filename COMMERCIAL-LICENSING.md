# Commercial licensing

This project is **dual-licensed**. There are two separate grants, and you pick
one:

```
                ┌── GNU AGPL v3.0 only + plugin exception   (free to everyone)
only-chat ──────┤
                └── separate commercial terms                (by agreement, this page)
```

The free side is the unmodified AGPL (`LICENSE`) plus one additional
permission for plugins (`PLUGIN-EXCEPTION.md`). The plugins that ship in
`src/plugins/` are MIT on top of that (`src/plugins/LICENSE`), and the name and
logo are covered by neither grant (`TRADEMARKS.md`).

If the free side's conditions do not work for you, contact dragon-fish
(<xiaoyujundesu@outlook.com>). This page is a description and a contact
address; the commercial licence itself is a separate agreement signed at the
time.

## Start here: does any of this apply to you?

only-chat is network software, so the line that decides your obligations is
not distribution — it is **whether your instance is a Public Service**: offered
to the general public, or to customers or clients as part of a product or
service, **paid or free**. `PLUGIN-EXCEPTION.md` has the exact definition.

| What you are doing | What applies |
| --- | --- |
| Running an instance **used only by you** | **Nothing.** Modify anything; section 2 of the AGPL attaches no conditions |
| Running an instance for your household, friends you invite, your team or your company | Your plugins may stay closed. Changes to the core: offer them to **those users** — nobody else |
| Selling or giving away a **plugin** for such instances | Your plugin, your terms |
| **Distributing** a modified only-chat | Its Corresponding Source, under the AGPL. Plugins shipped with it may keep their own terms |
| Running a **Public Service**, paid or free | Offer its users the source of the **whole** instance, plugins included, under the AGPL — or take the commercial licence |

The last row is the reason the commercial licence exists, and the reason the
plugin exception stops where it does. A public service built on this code has
two options: give its work back to the community, or pay for the right not to.

Section 2 of the AGPL is why the first row is not a loophole:

> You may make, run and propagate covered works that you do not convey,
> without conditions so long as your license otherwise remains in force.

Section 13 is why the second row reaches so few people:

> Notwithstanding any other provision of this License, if you modify the
> Program, your modified version must prominently offer **all users
> interacting with it remotely** through a computer network (if your version
> supports such interaction) an opportunity to receive the Corresponding Source
> **of your version** [...]

The obligation runs to the people using your instance, not to the public. A
repository link or a tarball handed to your own team discharges it.

**The AGPL asks for source, not for money.** Charging users of a Public Service
is permitted, as long as everything it runs is offered to them under the AGPL.

## Which one do you need?

The free side is enough if you want to:

- deploy only-chat for yourself, your team or your company, on your own
  Cloudflare account or anywhere else
- write plugins for it and keep them private, or sell them to people who
  deploy it the same way
- read, study, fork and learn from the code, and reuse the shipped plugins
  under MIT
- run a Public Service whose complete source, plugins included, you offer to
  its users under the AGPL

You need the commercial licence if you want to:

- run a Public Service without offering its source — closed plugins, a closed
  fork, or both
- combine the code into a work under a licence incompatible with the AGPL

Running an independent program alongside only-chat does not put that program
under the AGPL; the licence calls such a combination an *aggregate*. Where the
line falls in a given case is a real question, and it is the sort of question
worth asking a lawyer rather than a README.

## Why dual licensing is possible here

Because the copyright holder has the rights needed to license the work under
both sets of terms. Nothing in the AGPL constrains the person who granted it —
a copyright holder may license their own work as many different ways as they
like.

That stays true for outside contributions only because contributors grant the
rights needed to sublicense their work under alternative terms. Contributors
keep their own copyright; what they grant is a licence broad enough to carry
their lines into a commercial grant. See `CONTRIBUTING.md`.

This is the same arrangement Qt, MySQL and Grafana ship under.

## What this does not cover

The dual licence applies to **this repository's own code and documentation**.
It does not extend to third-party components, which keep their own terms — see
`NOTICE.md` — and it does not include the name or logo, which have their own
page, `TRADEMARKS.md`.

It also does not reach anything only-chat talks to. The model providers, their
APIs, their model weights and their terms of service are not this project's to
license, and neither is any content a model produces. **A commercial licence to
this code is not a licence to anything in `NOTICE.md`, and not a licence to
anything upstream of the API calls.** Those you clear yourself.
