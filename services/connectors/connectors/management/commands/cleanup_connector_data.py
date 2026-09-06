from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand
from django.utils import timezone

from connectors.models import AuthorizationCode, AuthorizationSession, DocumentPage


class Command(BaseCommand):
    help = "Remove expired auth state and acknowledged private document payloads."

    def handle(self, *args, **options):
        now = timezone.now()
        sessions, _ = AuthorizationSession.objects.filter(expires_at__lt=now).delete()
        codes, _ = AuthorizationCode.objects.filter(expires_at__lt=now).delete()
        pages, _ = DocumentPage.objects.filter(
            acknowledged_at__lt=now
            - timedelta(hours=settings.CONNECTORS_PAGE_TTL_HOURS)
        ).delete()
        self.stdout.write(f"removed sessions={sessions} codes={codes} pages={pages}")
