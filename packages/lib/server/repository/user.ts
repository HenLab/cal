import { whereClauseForOrgWithSlugOrRequestedSlug } from "@calcom/ee/organizations/lib/orgDomains";
import prisma from "@calcom/prisma";
import type { UpId, UserProfile } from "@calcom/types/UserProfile";

import { isOrganization } from "../../entityPermissionUtils";
import logger from "../../logger";
import { safeStringify } from "../../safeStringify";
import { ProfileRepository } from "./profile";
import { getParsedTeam } from "./teamUtils";
import type { User as UserType, Prisma } from ".prisma/client";

const log = logger.getSubLogger({ prefix: ["[repository/user]"] });

export const ORGANIZATION_ID_UNKNOWN = "ORGANIZATION_ID_UNKNOWN";
export class UserRepository {
  static async findTeamsByUserId({ userId }: { userId: UserType["id"] }) {
    const teamMemberships = await prisma.membership.findMany({
      where: {
        userId: userId,
      },
      include: {
        team: true,
      },
    });

    const acceptedTeamMemberships = teamMemberships.filter((membership) => membership.accepted);
    const pendingTeamMemberships = teamMemberships.filter((membership) => !membership.accepted);

    return {
      teams: acceptedTeamMemberships.map((membership) => membership.team),
      memberships: teamMemberships,
      acceptedTeamMemberships,
      pendingTeamMemberships,
    };
  }

  static async findOrganizations({ userId }: { userId: UserType["id"] }) {
    const { acceptedTeamMemberships } = await UserRepository.findTeamsByUserId({
      userId,
    });

    const acceptedOrgMemberships = acceptedTeamMemberships.filter((membership) =>
      isOrganization({ team: membership.team })
    );

    const organizations = acceptedOrgMemberships.map((membership) => membership.team);

    return {
      organizations,
    };
  }

  /**
   * It is aware of the fact that a user can be part of multiple organizations.
   */
  static async findUsersByUsername({
    orgSlug,
    usernameList,
  }: {
    orgSlug: string | null;
    usernameList: string[];
  }) {
    const { where, profiles } = await UserRepository._getWhereClauseForFindingUsersByUsername({
      orgSlug,
      usernameList,
    });

    log.debug("findUsersByUsername", safeStringify({ where, profiles }));

    return (
      await prisma.user.findMany({
        where,
      })
    ).map((user) => {
      // User isn't part of any organization
      if (!profiles) {
        return {
          ...user,
          profile: ProfileRepository.buildPersonalProfileFromUser({ user }),
        };
      }
      const profile = profiles.find((profile) => profile.user.id === user.id) ?? null;
      if (!profile) {
        log.error("Profile not found for user", safeStringify({ user, profiles }));
        // Profile must be there because profile itself was used to retrieve the user
        throw new Error("Profile couldn't be found");
      }
      const { user: _1, ...profileWithoutUser } = profile;
      return {
        ...user,
        profile: profileWithoutUser,
      };
    });
  }

  static async _getWhereClauseForFindingUsersByUsername({
    orgSlug,
    usernameList,
  }: {
    orgSlug: string | null;
    usernameList: string[];
  }) {
    // Lookup in profiles because that's where the organization usernames exist
    const profiles = orgSlug
      ? (
          await ProfileRepository.findManyByOrgSlugOrRequestedSlug({
            orgSlug: orgSlug,
            usernames: usernameList,
          })
        ).map((profile) => ({
          ...profile,
          organization: getParsedTeam(profile.organization),
        }))
      : null;

    const where = profiles
      ? {
          // Get UserIds from profiles
          id: {
            in: profiles.map((profile) => profile.user.id),
          },
        }
      : {
          username: {
            in: usernameList,
          },
          ...(orgSlug
            ? {
                organization: whereClauseForOrgWithSlugOrRequestedSlug(orgSlug),
              }
            : {
                organization: null,
              }),
        };

    return { where, profiles };
  }

  static async findByEmailAndIncludeProfiles({ email }: { email: string }) {
    const user = await prisma.user.findUnique({
      where: {
        email: email.toLowerCase(),
      },
      select: {
        locked: true,
        role: true,
        id: true,
        username: true,
        name: true,
        email: true,
        metadata: true,
        identityProvider: true,
        password: true,
        twoFactorEnabled: true,
        twoFactorSecret: true,
        backupCodes: true,
        locale: true,
        teams: {
          include: {
            team: true,
          },
        },
      },
    });

    if (!user) {
      return null;
    }

    const allProfiles = await ProfileRepository.findAllProfilesForUserIncludingMovedUser(user);
    return {
      ...user,
      allProfiles,
    };
  }

  static async findById({ id }: { id: number }) {
    const user = await prisma.user.findUnique({
      where: {
        id,
      },
    });

    if (!user) {
      return null;
    }
    return user;
  }

  static async findManyByOrganization({ organizationId }: { organizationId: number }) {
    const profiles = await ProfileRepository.findManyForOrg({ organizationId });
    return profiles.map((profile) => profile.user);
  }

  static isAMemberOfOrganization({
    user,
    organizationId,
  }: {
    user: { profiles: { organizationId: number }[] };
    organizationId: number;
  }) {
    return user.profiles.some((profile) => profile.organizationId === organizationId);
  }

  static async enrichUserWithTheProfile<T extends { username: string | null; id: number }>({
    user,
    upId,
  }: {
    user: T;
    upId: UpId;
  }) {
    log.debug("enrichUserWithTheProfile", safeStringify({ user, upId }));
    const profile = await ProfileRepository.findByUpId(upId);
    if (!profile) {
      return {
        ...user,
        profile: ProfileRepository.buildPersonalProfileFromUser({ user }),
      };
    }
    return {
      ...user,
      profile,
    };
  }

  /**
   * Use this method if you don't directly has the profileId.
   * It can happen in two cases:
   * 1. While dealing with a User that hasn't been added to any organization yet and thus have no Profile entries.
   * 2. While dealing with a User that has been moved to a Profile i.e. he was invited to an organization when he was an existing user.
   */
  static async enrichUserWithItsProfile<T extends { id: number; username: string | null }>({
    user,
  }: {
    user: T;
  }): Promise<T & { profile: UserProfile }> {
    const profiles = await ProfileRepository.findManyForUser({ id: user.id });
    if (profiles.length) {
      const profile = profiles[0];
      return {
        ...user,
        username: profile.username,
        profile,
      };
    }

    // If no organization profile exists, use the personal profile so that the returned user is normalized to have a profile always
    return {
      ...user,
      profile: ProfileRepository.buildPersonalProfileFromUser({ user }),
    };
  }

  static async enrichEntityWithProfile<
    T extends
      | {
          profile: {
            id: number;
            username: string | null;
            organizationId: number | null;
            organization?: {
              id: number;
              name: string;
              calVideoLogo: string | null;
              slug: string | null;
              metadata: Prisma.JsonValue;
            };
          };
        }
      | {
          user: {
            username: string | null;
            id: number;
          };
        }
  >(entity: T) {
    if ("profile" in entity) {
      const { profile, ...entityWithoutProfile } = entity;
      const { organization, ...profileWithoutOrganization } = profile || {};
      const parsedOrg = organization ? getParsedTeam(organization) : null;

      const ret = {
        ...entityWithoutProfile,
        profile: {
          ...profileWithoutOrganization,
          ...(parsedOrg
            ? {
                organization: parsedOrg,
              }
            : {
                organization: null,
              }),
        },
      };
      return ret;
    } else {
      const profiles = await ProfileRepository.findManyForUser(entity.user);
      if (!profiles.length) {
        return {
          ...entity,
          profile: ProfileRepository.buildPersonalProfileFromUser({ user: entity.user }),
        };
      } else {
        return {
          ...entity,
          profile: profiles[0],
        };
      }
    }
  }

  static async updateWhereId({
    whereId,
    data,
  }: {
    whereId: number;
    data: {
      movedToProfileId?: number | null;
    };
  }) {
    return prisma.user.update({
      where: {
        id: whereId,
      },
      data: {
        movedToProfile: data.movedToProfileId
          ? {
              connect: {
                id: data.movedToProfileId,
              },
            }
          : undefined,
      },
    });
  }
}
