import os
from pathlib import Path
import secrets
import sys

import psycopg2


def envfile(path):
    result = {}
    for line in Path(path).read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            value = value.strip()
            if len(value) > 1 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            result[key.strip()] = value
    return result


config = envfile('/opt/forkluck-feedback/.env')
os.environ.update(envfile('/etc/forkluck/backend.env'))
os.environ['DJANGO_SETTINGS_MODULE'] = 'config.settings'
sys.path.insert(0, '/opt/forkluck/current/backend')
import django
django.setup()
from forkluck.models import User
owners = list(User.objects.filter(is_superuser=True, is_active=True))
assert len(owners) == 1, 'Expected the one existing Forkluck owner.'
owner = owners[0]
with psycopg2.connect(config['FIDER_DATABASE_URL']) as conn:
    with conn.cursor() as cur:
        cur.execute('SELECT count(*) FROM tenants')
        if cur.fetchone()[0]:
            print('Existing board preserved; bootstrap already complete.')
            sys.exit(0)
        cur.execute('''INSERT INTO tenants
            (name,subdomain,created_at,cname,invitation,welcome_message,status,is_private,
             custom_css,logo_bkey,locale,is_email_auth_allowed,is_feed_enabled,
             prevent_indexing,is_moderation_enabled,is_pro,welcome_header,description_template)
            VALUES ('Forkluck','forkluck',now(),'feedback.forkluck.com',%s,%s,1,false,
                    '','','en',false,true,false,false,true,'Help shape Forkluck',%s) RETURNING id''', (
            'What would make Forkluck better for your kitchen?',
            "Share an idea for Forkluck, vote for the improvements you need, and tell us what would make your kitchen's work easier.\n\n[← Back to Forkluck](https://forkluck.com/)",
            "What problem are you trying to solve?\n\nHow do you handle it today?\n\nWhat would help?\n\nPlease check existing ideas before posting. Keep recipes, invoices, customer details, and other private business information out of this public board.",
        ))
        tenant = cur.fetchone()[0]
        for name, email, api_key, uuid in (
            ('Forkluck service', '', config['FORKLUCK_FEEDBACK_API_KEY'], None),
            (owner.name[:100] or 'Owner', owner.email, None, str(owner.pk)),
        ):
            cur.execute('''INSERT INTO users
                (name,email,created_at,tenant_id,role,status,avatar_type,avatar_bkey,security_stamp,api_key,api_key_date)
                VALUES (%s,%s,now(),%s,3,1,1,'',%s,%s,now()) RETURNING id''',
                        (name,email,tenant,secrets.token_urlsafe(48),api_key))
            user_id = cur.fetchone()[0]
            if uuid:
                cur.execute('''INSERT INTO user_providers (tenant_id,user_id,provider,provider_uid,created_at)
                               VALUES (%s,%s,'_forkluck',%s,now())''', (tenant,user_id,uuid))
        origin = 'https://app.forkluck.com/api/auth/feedback/'
        cur.execute('''INSERT INTO oauth_providers
            (tenant_id,provider,display_name,status,is_trusted,client_id,client_secret,
             authorize_url,token_url,profile_url,scope,json_user_id_path,json_user_name_path,
             json_user_email_path,json_user_roles_path,allowed_roles,logo_bkey)
            VALUES (%s,'_forkluck','Forkluck',2,true,'forkluck-feedback',%s,%s,%s,%s,
                    'profile','id','name','email','','','')''',
                    (tenant,config['FORKLUCK_FEEDBACK_CLIENT_SECRET'],origin+'authorize',origin+'token',origin+'profile'))
print('Forkluck board, existing owner, service identity and single sign-in provider prepared.')
